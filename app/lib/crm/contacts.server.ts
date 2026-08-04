/**
 * Contact mirror data-access: list/search/filter/sort/paginate + single get + CRM mutations.
 * Lists are served from the local mirror for speed (see DECISIONS.md §3). SERVER ONLY.
 */

import type { Contact, Prisma } from "@prisma/client";
import prisma from "../../db.server";
import {
  DEFAULT_LIFECYCLE_STAGE,
  canReceive,
  isLifecycleStage,
  spendTierById,
  type LifecycleStage,
} from "./constants";
import type { ContactListParams } from "./types";
import { logActivity } from "./activity.server";

const contactWithTags = {
  include: { tags: { include: { tag: true } } },
} satisfies Prisma.ContactDefaultArgs;

export type ContactWithTags = Prisma.ContactGetPayload<typeof contactWithTags>;

/** Build the Prisma `where` for a filter (shop-scoped). */
function buildWhere(shop: string, params: ContactListParams): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [{ shop }];

  const search = params.search?.trim();
  if (search) {
    // PostgreSQL string filters are case-sensitive unless explicitly configured otherwise.
    and.push({
      OR: [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  if (params.stages && params.stages.length > 0) {
    and.push({ lifecycleStage: { in: params.stages } });
  }

  if (params.tagIds && params.tagIds.length > 0) {
    and.push({ tags: { some: { tagId: { in: params.tagIds } } } });
  }

  if (params.spendTiers && params.spendTiers.length > 0) {
    const ranges: Prisma.ContactWhereInput[] = [];
    for (const id of params.spendTiers) {
      const tier = spendTierById(id);
      if (!tier) continue;
      ranges.push({
        amountSpent: {
          gte: tier.gte,
          ...(tier.lt !== null ? { lt: tier.lt } : {}),
        },
      });
    }
    if (ranges.length > 0) and.push({ OR: ranges });
  }

  return { AND: and };
}

function buildOrderBy(
  params: ContactListParams,
): Prisma.ContactOrderByWithRelationInput[] {
  const dir = params.sortDir;
  switch (params.sortField) {
    case "name":
      return [{ firstName: dir }, { lastName: dir }];
    case "email":
      return [{ email: dir }];
    case "amountSpent":
      return [{ amountSpent: dir }];
    case "ordersCount":
      return [{ ordersCount: dir }];
    case "lastOrderAt":
      return [{ lastOrderAt: dir }];
    case "lifecycleStage":
      return [{ lifecycleStage: dir }];
    case "createdAt":
      return [{ createdAt: dir }];
    case "updatedAt":
    default:
      return [{ updatedAt: dir }];
  }
}

export interface ContactListResult {
  rows: ContactWithTags[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export async function listContacts(
  shop: string,
  params: ContactListParams,
): Promise<ContactListResult> {
  const where = buildWhere(shop, params);
  const pageSize = Math.min(Math.max(params.pageSize, 1), 100);
  const page = Math.max(params.page, 1);

  const [rows, total] = await prisma.$transaction([
    prisma.contact.findMany({
      where,
      orderBy: buildOrderBy(params),
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { tags: { include: { tag: true } } },
    }),
    prisma.contact.count({ where }),
  ]);

  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getContact(
  shop: string,
  id: string,
): Promise<ContactWithTags | null> {
  return prisma.contact.findFirst({
    where: { id, shop },
    include: { tags: { include: { tag: true } } },
  });
}

export async function getContactByShopifyId(
  shop: string,
  shopifyCustomerId: string,
): Promise<ContactWithTags | null> {
  return prisma.contact.findFirst({
    where: { shop, shopifyCustomerId },
    include: { tags: { include: { tag: true } } },
  });
}

/**
 * Find a contact by email within a shop using an exact PostgreSQL comparison. Uses the
 * `(shop, email)` index. `findFirst` because the index is non-unique — pick the most recently
 * updated on a collision. Used for inbound matching.
 */
export async function findContactByEmail(
  shop: string,
  email: string,
): Promise<Contact | null> {
  const value = email.trim();
  if (!value) return null;
  return prisma.contact.findFirst({
    where: { shop, email: value },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Find a contact by phone within a shop. Best-effort: matches against the stored value (callers
 * pass a normalized E.164 string). Uses the `(shop, phone)` index. Used for inbound SMS matching.
 */
export async function findContactByPhone(
  shop: string,
  phone: string,
): Promise<Contact | null> {
  const value = phone.trim();
  if (!value) return null;
  return prisma.contact.findFirst({
    where: { shop, phone: value },
    orderBy: { updatedAt: "desc" },
  });
}

export async function countContacts(shop: string): Promise<number> {
  return prisma.contact.count({ where: { shop } });
}

export async function countContactsSince(shop: string, since: Date): Promise<number> {
  return prisma.contact.count({ where: { shop, createdAt: { gte: since } } });
}

/** Change a contact's lifecycle stage and log a STAGE_CHANGED activity. */
export async function setLifecycleStage(
  shop: string,
  contactId: string,
  stage: string,
): Promise<void> {
  const nextStage: LifecycleStage = isLifecycleStage(stage)
    ? stage
    : DEFAULT_LIFECYCLE_STAGE;
  const current = await prisma.contact.findFirst({
    where: { id: contactId, shop },
    select: { lifecycleStage: true },
  });
  if (!current) throw new Error("Contact not found.");
  if (current.lifecycleStage === nextStage) return;

  await prisma.contact.update({
    where: { id: contactId },
    data: { lifecycleStage: nextStage },
  });
  await logActivity({
    shop,
    contactId,
    type: "STAGE_CHANGED",
    payload: { from: current.lifecycleStage, to: nextStage },
  });
}

/** Resolve a set of contact ids to those that belong to this shop (guards bulk actions). */
export async function resolveOwnedContactIds(
  shop: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.contact.findMany({
    where: { shop, id: { in: ids } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Count how many of the given contacts can receive email / valid SMS (for bulk summaries). */
export interface ChannelCounts {
  withEmail: number;
  withValidPhone: number;
  /** Consented AND reachable — the number that will actually be sent. */
  emailReachable: number;
  smsReachable: number;
  /** Have the address but are not subscribed, so they will be skipped as NO_CONSENT. */
  emailNoConsent: number;
  smsNoConsent: number;
}

/**
 * Recipient breakdown for the bulk-send screen.
 *
 * Reports reachability and consent separately so the merchant sees why a selection of 500 will
 * only send to 120 *before* they hit send, rather than discovering it in the results.
 */
export async function getContactChannelCounts(
  shop: string,
  ids: string[],
): Promise<ChannelCounts> {
  const empty: ChannelCounts = {
    withEmail: 0,
    withValidPhone: 0,
    emailReachable: 0,
    smsReachable: 0,
    emailNoConsent: 0,
    smsNoConsent: 0,
  };
  if (ids.length === 0) return empty;

  const rows = await prisma.contact.findMany({
    where: { shop, id: { in: ids } },
    select: {
      email: true,
      phone: true,
      emailMarketingState: true,
      smsMarketingState: true,
    },
  });
  const { normalizeE164 } = await import("../phone");

  const counts = { ...empty };
  for (const r of rows) {
    const hasEmail = Boolean(r.email);
    const hasPhone = normalizeE164(r.phone).ok;
    if (hasEmail) counts.withEmail += 1;
    if (hasPhone) counts.withValidPhone += 1;

    if (canReceive("EMAIL", r)) {
      if (hasEmail) counts.emailReachable += 1;
    } else if (hasEmail) {
      counts.emailNoConsent += 1;
    }

    if (canReceive("SMS", r)) {
      if (hasPhone) counts.smsReachable += 1;
    } else if (hasPhone) {
      counts.smsNoConsent += 1;
    }
  }
  return counts;
}
