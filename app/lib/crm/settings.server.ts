/**
 * ShopSettings access — Brevo BYOK credentials and sender config. SERVER ONLY.
 *
 * The plaintext Brevo API key never leaves this module's `getDecryptedBrevoKey` (used at send
 * time). Everything returned to loaders/UI is the safe {@link BrevoStatus} — no secret.
 */

import { randomBytes } from "crypto";
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

/* ------------------------------------------------------------------ */
/* Inbound (two-way) messaging — Brevo Conversations webhook config     */
/* ------------------------------------------------------------------ */

export interface InboundConfig {
  /** The secret token embedded in the per-shop webhook URL (a capability URL). Null until generated. */
  token: string | null;
  /** Whether an optional basic-auth shared secret is configured (never the value). */
  secretSet: boolean;
}

function newInboundToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Inbound webhook config for the Settings loader (safe — token is a capability URL, secret hidden). */
export async function getInboundConfig(shop: string): Promise<InboundConfig> {
  const s = await getOrCreateSettings(shop);
  return { token: s.brevoInboundToken, secretSet: Boolean(s.brevoInboundSecret) };
}

/** Return the existing inbound token, generating + persisting one on first use. */
export async function getOrCreateInboundToken(shop: string): Promise<string> {
  const s = await getOrCreateSettings(shop);
  if (s.brevoInboundToken) return s.brevoInboundToken;
  const token = newInboundToken();
  await prisma.shopSettings.update({ where: { shop }, data: { brevoInboundToken: token } });
  return token;
}

/** Generate a fresh inbound token (revokes the old webhook URL). */
export async function rotateInboundToken(shop: string): Promise<string> {
  const token = newInboundToken();
  await prisma.shopSettings.upsert({
    where: { shop },
    update: { brevoInboundToken: token },
    create: { shop, brevoInboundToken: token },
  });
  return token;
}

/** Set or clear the optional basic-auth shared secret (encrypted at rest like the API key). */
export async function setInboundSecret(shop: string, secret: string | null): Promise<void> {
  const trimmed = secret?.trim();
  const encrypted =
    trimmed && isEncryptionConfigured() ? encryptSecret(trimmed) : null;
  await prisma.shopSettings.upsert({
    where: { shop },
    update: { brevoInboundSecret: encrypted },
    create: { shop, brevoInboundSecret: encrypted },
  });
}

/**
 * Resolve a shop from an inbound webhook token (used by the public webhook route). Returns the
 * shop and the decrypted basic-auth secret (if any). Returns null for an unknown/empty token.
 * SERVER ONLY — never expose to the client.
 */
export async function findShopByInboundToken(
  token: string,
): Promise<{ shop: string; secret: string | null } | null> {
  const value = token?.trim();
  if (!value) return null;
  const s = await prisma.shopSettings.findUnique({ where: { brevoInboundToken: value } });
  if (!s) return null;
  let secret: string | null = null;
  if (s.brevoInboundSecret) {
    try {
      secret = decryptSecret(s.brevoInboundSecret);
    } catch {
      // Can't decrypt (e.g. ENCRYPTION_KEY changed) — treat the optional layer as absent; the
      // URL token is still the required boundary. Logged by the caller if needed.
      secret = null;
    }
  }
  return { shop: s.shop, secret };
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
