/** Size-preference persistence. SERVER ONLY. */

import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { ContactPreferenceKey } from "./constants";
import { derivePreferences, type PreferenceLineItem } from "./preferences";

type PreferenceDb = Pick<Prisma.TransactionClient, "processedOrder" | "contactPreference">;

function parseStoredLineItems(value: string | null): PreferenceLineItem[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): PreferenceLineItem[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return [
        {
          title: typeof row.title === "string" ? row.title : null,
          variantTitle:
            typeof row.variantTitle === "string" ? row.variantTitle : null,
          quantity: typeof row.quantity === "number" ? row.quantity : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Rebuild every DERIVED preference from the contact's accumulated local order history. */
export async function recomputeDerivedPreferences(
  shop: string,
  contactId: string,
  db: PreferenceDb = prisma,
): Promise<void> {
  const orders = await db.processedOrder.findMany({
    where: { shop, contactId },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
    select: { lineItems: true },
  });
  const derived = derivePreferences(
    orders.flatMap((order) => parseStoredLineItems(order.lineItems)),
  );

  for (const preference of derived) {
    await db.contactPreference.upsert({
      where: {
        contactId_key_source: {
          contactId,
          key: preference.key,
          source: "DERIVED",
        },
      },
      update: {
        value: preference.value,
        sampleCount: preference.sampleCount,
      },
      create: {
        shop,
        contactId,
        key: preference.key,
        value: preference.value,
        source: "DERIVED",
        sampleCount: preference.sampleCount,
      },
    });
  }

  const activeKeys = derived.map((preference) => preference.key);
  await db.contactPreference.deleteMany({
    where: {
      shop,
      contactId,
      source: "DERIVED",
      ...(activeKeys.length > 0 ? { key: { notIn: activeKeys } } : {}),
    },
  });
}

export async function saveManualPreference(
  shop: string,
  contactId: string,
  key: ContactPreferenceKey,
  value: string,
): Promise<void> {
  const contact = await prisma.contact.findFirst({
    where: { shop, id: contactId },
    select: { id: true },
  });
  if (!contact) throw new Error("Contact not found.");

  await prisma.contactPreference.upsert({
    where: {
      contactId_key_source: { contactId, key, source: "MANUAL" },
    },
    update: { value, sampleCount: 0 },
    create: { shop, contactId, key, value, source: "MANUAL", sampleCount: 0 },
  });
}

export async function deleteManualPreference(
  shop: string,
  contactId: string,
  key: ContactPreferenceKey,
): Promise<void> {
  await prisma.contactPreference.deleteMany({
    where: { shop, contactId, key, source: "MANUAL" },
  });
}
