/**
 * GDPR/CCPA mandatory compliance behaviors (see brief §4 / §7). SERVER ONLY.
 *  - customers/data_request → assemble the stored CRM data for that customer
 *  - customers/redact       → delete that customer's CRM data
 *  - shop/redact            → delete ALL data for the shop
 * Everything is scoped by shop so one shop can never affect another's data.
 */

import prisma from "../../db.server";

export interface CompliancePayload {
  shop_id?: number;
  shop_domain?: string;
  customer?: { id?: number | string; email?: string; phone?: string };
  orders_requested?: number[];
  orders_to_redact?: number[];
}

export function customerGidFromCompliancePayload(p: CompliancePayload): string | null {
  const id = p.customer?.id;
  if (id == null) return null;
  return `gid://shopify/Customer/${id}`;
}

/** Gather all CRM data stored for a customer, for a customers/data_request. */
export async function assembleCustomerData(shop: string, customerGid: string) {
  const contact = await prisma.contact.findFirst({
    where: { shop, shopifyCustomerId: customerGid },
    include: {
      tags: { include: { tag: true } },
      notes: true,
      activities: true,
      messageLogs: true,
      tasks: true,
    },
  });
  return {
    shop,
    shopifyCustomerId: customerGid,
    found: Boolean(contact),
    data: contact,
  };
}

/**
 * Assemble the export AND persist it for the merchant to retrieve (see DECISIONS.md §14).
 *
 * Shopify has no callback for data requests: the merchant must deliver the data to the customer
 * themselves, within 30 days. Storing it — and surfacing it in the app — is what turns the
 * webhook into something they can actually act on.
 *
 * A row is written even when the shop holds no CRM data for that customer, because "we hold
 * nothing about you" is itself a valid and required response.
 */
export async function recordDataRequest(
  shop: string,
  customerGid: string,
  customerEmail?: string | null,
): Promise<string> {
  const assembled = await assembleCustomerData(shop, customerGid);
  const row = await prisma.dataRequest.create({
    data: {
      shop,
      shopifyCustomerId: customerGid,
      customerEmail: customerEmail ?? null,
      payload: JSON.stringify(assembled, null, 2),
    },
    select: { id: true },
  });
  return row.id;
}

/** Open (unfulfilled) data requests for a shop — drives the Privacy screen's badge. */
export async function countOpenDataRequests(shop: string): Promise<number> {
  return prisma.dataRequest.count({ where: { shop, status: "OPEN" } });
}

/** Data requests for the Privacy screen, newest first. */
export async function listDataRequests(shop: string, limit = 50) {
  return prisma.dataRequest.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      shopifyCustomerId: true,
      customerEmail: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
    },
  });
}

/** One request including its payload (for download). Shop-scoped. */
export async function getDataRequest(shop: string, id: string) {
  return prisma.dataRequest.findFirst({ where: { shop, id } });
}

/** Mark a request fulfilled once the merchant has sent the data to the customer. */
export async function resolveDataRequest(
  shop: string,
  id: string,
  staffId: string | null,
): Promise<void> {
  await prisma.dataRequest.updateMany({
    where: { shop, id },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByStaffId: staffId },
  });
}

/** Delete a single customer's CRM data (idempotent). */
export async function redactCustomer(shop: string, customerGid: string): Promise<void> {
  const contact = await prisma.contact.findFirst({
    where: { shop, shopifyCustomerId: customerGid },
    select: { id: true },
  });
  if (!contact) return;
  // Remove tasks tied to this contact explicitly (the relation only nulls them on delete).
  await prisma.task.deleteMany({ where: { shop, contactId: contact.id } });
  // Deleting the contact cascades notes, activities, message logs and contact-tag links.
  await prisma.contact.deleteMany({ where: { shop, id: contact.id } });
}

/** Delete ALL data for a shop (shop/redact, ~48h after uninstall). */
export async function redactShop(shop: string): Promise<void> {
  await prisma.$transaction([
    prisma.messageLog.deleteMany({ where: { shop } }),
    prisma.activity.deleteMany({ where: { shop } }),
    prisma.note.deleteMany({ where: { shop } }),
    prisma.contactTag.deleteMany({ where: { shop } }),
    prisma.task.deleteMany({ where: { shop } }),
    prisma.tag.deleteMany({ where: { shop } }),
    prisma.contact.deleteMany({ where: { shop } }),
    prisma.segment.deleteMany({ where: { shop } }),
    prisma.messageTemplate.deleteMany({ where: { shop } }),
    prisma.messageBatch.deleteMany({ where: { shop } }),
    prisma.processedOrder.deleteMany({ where: { shop } }),
    prisma.dataRequest.deleteMany({ where: { shop } }),
    prisma.job.deleteMany({ where: { shop } }),
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);
}
