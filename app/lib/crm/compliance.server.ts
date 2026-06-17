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
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);
}
