/**
 * ShopSettings access — Brevo BYOK credentials and sender config. SERVER ONLY.
 *
 * The plaintext Brevo API key never leaves this module's `getDecryptedBrevoKey` (used at send
 * time). Everything returned to loaders/UI is the safe {@link BrevoStatus} — no secret.
 */

import prisma from "../../db.server";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "../crypto.server";
import { validateBrevoKey } from "../brevo/client.server";

export interface BrevoStatus {
  connected: boolean;
  hasKey: boolean;
  encryptionConfigured: boolean;
  accountEmail: string | null;
  senderEmail: string | null;
  senderName: string | null;
  smsSender: string | null;
}

export async function getOrCreateSettings(shop: string) {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

/** Safe status object for loaders/UI — never includes the secret. */
export async function getBrevoStatus(shop: string): Promise<BrevoStatus> {
  const s = await getOrCreateSettings(shop);
  return {
    connected: s.brevoConnected && Boolean(s.brevoApiKeyEncrypted),
    hasKey: Boolean(s.brevoApiKeyEncrypted),
    encryptionConfigured: isEncryptionConfigured(),
    accountEmail: s.brevoAccountEmail,
    senderEmail: s.brevoSenderEmail,
    senderName: s.brevoSenderName,
    smsSender: s.brevoSmsSender,
  };
}

/** Decrypt the stored Brevo key. Returns null if none stored. SERVER/SEND-TIME ONLY. */
export async function getDecryptedBrevoKey(shop: string): Promise<string | null> {
  const s = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!s?.brevoApiKeyEncrypted) return null;
  return decryptSecret(s.brevoApiKeyEncrypted);
}

export interface SaveKeyResult {
  ok: boolean;
  error?: string;
  accountEmail?: string | null;
}

/** Validate a Brevo key against the live account, then encrypt + store it. */
export async function saveBrevoKey(shop: string, apiKey: string): Promise<SaveKeyResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: "Enter a Brevo API key." };
  if (!isEncryptionConfigured()) {
    return {
      ok: false,
      error:
        "Server encryption key (ENCRYPTION_KEY) is not configured. The API key cannot be stored securely.",
    };
  }

  const validation = await validateBrevoKey(trimmed);
  if (!validation.ok) {
    return {
      ok: false,
      error:
        validation.status === 401
          ? "That Brevo API key was rejected. Check you copied the full REST API key."
          : `Could not validate the key with Brevo: ${validation.error}`,
    };
  }

  const accountEmail = validation.data.email ?? null;
  const encrypted = encryptSecret(trimmed);
  await prisma.shopSettings.upsert({
    where: { shop },
    update: {
      brevoApiKeyEncrypted: encrypted,
      brevoConnected: true,
      brevoAccountEmail: accountEmail,
    },
    create: {
      shop,
      brevoApiKeyEncrypted: encrypted,
      brevoConnected: true,
      brevoAccountEmail: accountEmail,
    },
  });
  return { ok: true, accountEmail };
}

export async function removeBrevoKey(shop: string): Promise<void> {
  await prisma.shopSettings.upsert({
    where: { shop },
    update: { brevoApiKeyEncrypted: null, brevoConnected: false, brevoAccountEmail: null },
    create: { shop },
  });
}

export async function updateSenderSettings(
  shop: string,
  input: { senderEmail?: string; senderName?: string; smsSender?: string },
): Promise<void> {
  await prisma.shopSettings.upsert({
    where: { shop },
    update: {
      brevoSenderEmail: input.senderEmail?.trim() || null,
      brevoSenderName: input.senderName?.trim() || null,
      brevoSmsSender: input.smsSender?.trim() || null,
    },
    create: {
      shop,
      brevoSenderEmail: input.senderEmail?.trim() || null,
      brevoSenderName: input.senderName?.trim() || null,
      brevoSmsSender: input.smsSender?.trim() || null,
    },
  });
}
