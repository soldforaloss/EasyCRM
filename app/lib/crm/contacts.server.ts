/**
 * Contact mirror data-access: list/search/filter/sort/paginate + single get + CRM mutations.
 * Lists are served from the local mirror for speed (see DECISIONS.md §3). SERVER ONLY.
 */

import type { Contact, Prisma } from "@prisma/client";
import prisma from "../../db.server";
import {
  DEFAULT_LIFECYCLE_STAGE,
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
    // NOTE: `contains` is case-insensitive on SQLite (dev). For Postgres prod, add
    // `mode: "insensitive"` — see DECISIONS.md §2.
    and.push({
      OR: [
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
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
 * Find a contact by email within a shop (case-insensitive on SQLite; for Postgres add
 * `mode: "insensitive"` per DECISIONS.md §2). Uses the `(shop, email)` index. `findFirst` because
 * the index is non-unique — pick the most recently updated on a collision. Used for inbound matching.
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
export async function getContactChannelCounts(
  shop: string,
  ids: string[],
): Promise<{ withEmail: number; withValidPhone: number }> {
  if (ids.length === 0) return { withEmail: 0, withValidPhone: 0 };
  const rows = await prisma.contact.findMany({
    where: { shop, id: { in: ids } },
    select: { email: true, phone: true },
  });
  const { normalizeE164 } = await import("../phone");
  let withEmail = 0;
  let withValidPhone = 0;
  for (const r of rows) {
    if (r.email) withEmail += 1;
    if (normalizeE164(r.phone).ok) withValidPhone += 1;
  }
  return { withEmail, withValidPhone };
}
