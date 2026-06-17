/** Note CRUD, integrated with the activity timeline. SERVER ONLY. */

import prisma from "../../db.server";
import { logActivity } from "./activity.server";

function preview(body: string, max = 100): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

async function assertOwnedContact(shop: string, contactId: string): Promise<void> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, shop },
    select: { id: true },
  });
  if (!contact) throw new Error("Contact not found.");
}

export async function listNotes(shop: string, contactId: string) {
  return prisma.note.findMany({
    where: { shop, contactId },
    orderBy: { createdAt: "desc" },
  });
}

export async function addNote(
  shop: string,
  contactId: string,
  body: string,
  authorStaffId?: string | null,
) {
  const text = body.trim();
  if (!text) throw new Error("Note cannot be empty.");
  await assertOwnedContact(shop, contactId);

  const note = await prisma.note.create({
    data: { shop, contactId, body: text, authorStaffId: authorStaffId ?? null },
  });
  await logActivity({
    shop,
    contactId,
    type: "NOTE",
    payload: { noteId: note.id, preview: preview(text) },
  });
  return note;
}

export async function editNote(shop: string, noteId: string, body: string) {
  const text = body.trim();
  if (!text) throw new Error("Note cannot be empty.");
  const result = await prisma.note.updateMany({
    where: { shop, id: noteId },
    data: { body: text },
  });
  if (result.count === 0) throw new Error("Note not found.");
}

export async function deleteNote(shop: string, noteId: string): Promise<void> {
  await prisma.note.deleteMany({ where: { shop, id: noteId } });
}
