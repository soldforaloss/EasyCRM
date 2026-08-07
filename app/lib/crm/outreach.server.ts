/** Manual outreach logging. Records staff-contact interactions without initiating contact. SERVER ONLY. */

import prisma from "../../db.server";
import { logActivity } from "./activity.server";
import type { ActivityType } from "./constants";

const OUTREACH_TYPES = [
  "OUTREACH_CALL",
  "OUTREACH_IN_PERSON",
  "OUTREACH_TEXT",
] as const satisfies readonly ActivityType[];

type OutreachType = (typeof OUTREACH_TYPES)[number];

function isOutreachType(value: string): value is OutreachType {
  return (OUTREACH_TYPES as readonly string[]).includes(value);
}

export async function logOutreach(
  shop: string,
  contactId: string,
  input: { type: string; note: string; staffId: string | null },
) {
  if (!isOutreachType(input.type)) throw new Error("Choose a valid outreach method.");

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, shop },
    select: { id: true },
  });
  if (!contact) throw new Error("Contact not found.");

  return logActivity({
    shop,
    contactId,
    type: input.type,
    payload: { note: input.note.trim(), staffId: input.staffId },
  });
}
