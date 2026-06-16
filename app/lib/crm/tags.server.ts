/** Tag + ContactTag data-access (normalized, shop-scoped). SERVER ONLY. */

import prisma from "../../db.server";

export async function listTags(shop: string) {
  return prisma.tag.findMany({
    where: { shop },
    orderBy: { name: "asc" },
    include: { _count: { select: { contacts: true } } },
  });
}

export async function getOrCreateTag(shop: string, rawName: string) {
  const name = rawName.trim();
  if (!name) throw new Error("Tag name is required.");
  return prisma.tag.upsert({
    where: { shop_name: { shop, name } },
    update: {},
    create: { shop, name },
  });
}

/** Add a tag (by name) to a contact, creating the tag if needed. Idempotent. */
export async function addTagToContact(shop: string, contactId: string, rawName: string) {
  // Guard: contact must belong to the shop.
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, shop },
    select: { id: true },
  });
  if (!contact) throw new Error("Contact not found.");

  const tag = await getOrCreateTag(shop, rawName);
  await prisma.contactTag.upsert({
    where: { contactId_tagId: { contactId, tagId: tag.id } },
    update: {},
    create: { contactId, tagId: tag.id, shop },
  });
  return tag;
}

export async function removeTagFromContact(
  shop: string,
  contactId: string,
  tagId: string,
): Promise<void> {
  await prisma.contactTag.deleteMany({ where: { shop, contactId, tagId } });
}

/** Delete a tag entirely (cascades ContactTag rows). */
export async function deleteTag(shop: string, tagId: string): Promise<void> {
  await prisma.tag.deleteMany({ where: { shop, id: tagId } });
}

/** Bulk-assign a tag (by name) to many contacts. Returns the number newly tagged. */
export async function addTagToContacts(
  shop: string,
  contactIds: string[],
  rawName: string,
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const tag = await getOrCreateTag(shop, rawName);
  const owned = await prisma.contact.findMany({
    where: { shop, id: { in: contactIds } },
    select: { id: true },
  });
  let count = 0;
  for (const c of owned) {
    const created = await prisma.contactTag.upsert({
      where: { contactId_tagId: { contactId: c.id, tagId: tag.id } },
      update: {},
      create: { contactId: c.id, tagId: tag.id, shop },
    });
    if (created) count += 1;
  }
  return count;
}
