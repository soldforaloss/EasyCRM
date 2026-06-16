/**
 * AES-256-GCM encryption for secrets at rest (the Brevo BYOK API key — see DECISIONS.md §5).
 *
 * SERVER ONLY. The `.server.ts` suffix guarantees this never reaches a client bundle.
 *
 * The 32-byte key comes from `process.env.ENCRYPTION_KEY` (hex or base64). Ciphertext is
 * stored as a single self-describing bundle string: `v1:<ivB64>:<tagB64>:<ciphertextB64>`.
 * GCM provides authenticated encryption, so tampering with any part fails `decrypt()`.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce — the GCM standard
const KEY_LENGTH = 32; // 256-bit key
const VERSION = "v1";

/**
 * Resolve and validate the encryption key from the environment.
 * Accepts a 64-char hex string or a 44-char base64 string (both decode to 32 bytes).
 */
function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  const trimmed = raw.trim();

  // Hex (preferred): exactly 64 hex chars.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Otherwise try base64 / base64url and require exactly 32 decoded bytes.
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === KEY_LENGTH) {
      return buf;
    }
  } catch {
    // fall through to the error below
  }

  throw new Error(
    "ENCRYPTION_KEY must decode to 32 bytes (use 64 hex chars or 32-byte base64).",
  );
}

/** True when a usable ENCRYPTION_KEY is configured. Use for graceful UI degradation. */
export function isEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt UTF-8 plaintext into a versioned, authenticated bundle string. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypt a bundle produced by {@link encryptSecret}. Throws on tampering or wrong key. */
export function decryptSecret(bundle: string): string {
  if (typeof bundle !== "string") {
    throw new Error("Invalid ciphertext bundle.");
  }
  const parts = bundle.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unrecognized ciphertext bundle format.");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid IV length in ciphertext bundle.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(), // throws if the auth tag does not verify
  ]);
  return plaintext.toString("utf8");
}

/**
 * Mask a secret for display: keeps the last `visible` characters, e.g. "••••••cdef".
 * Never reveals the full value. Safe to send to the client.
 */
export function maskSecret(secret: string, visible = 4): string {
  if (!secret) return "";
  const tail = secret.slice(-visible);
  return `${"•".repeat(Math.max(4, secret.length - visible))}${tail}`;
}

/** Constant-time string comparison helper (e.g. for token checks). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
