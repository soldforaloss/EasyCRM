import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  isEncryptionConfigured,
  maskSecret,
  safeEqual,
} from "./crypto.server";

const HEX_KEY =
  "f3f46a9b5b178e1573be739ba8a76c464cb85be7c7521f145addd4b70025e98f";

describe("crypto.server", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = HEX_KEY;
  });

  it("round-trips plaintext", () => {
    const secret = "xkeysib-abc123-SECRET-key-value";
    const bundle = encryptSecret(secret);
    expect(bundle).toMatch(/^v1:/);
    expect(bundle).not.toContain(secret);
    expect(decryptSecret(bundle)).toBe(secret);
  });

  it("uses a fresh IV each time (ciphertext differs for same input)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("accepts a base64 key of 32 bytes", () => {
    process.env.ENCRYPTION_KEY = Buffer.from(HEX_KEY, "hex").toString("base64");
    const bundle = encryptSecret("hello");
    expect(decryptSecret(bundle)).toBe("hello");
  });

  it("detects tampering with the ciphertext (GCM auth)", () => {
    const bundle = encryptSecret("tamper-me");
    const parts = bundle.split(":");
    // flip a character in the ciphertext segment
    const ct = parts[3];
    parts[3] = ct[0] === "A" ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("fails to decrypt with a different key", () => {
    const bundle = encryptSecret("secret");
    process.env.ENCRYPTION_KEY =
      "00000000000000000000000000000000000000000000000000000000000000ff";
    expect(() => decryptSecret(bundle)).toThrow();
  });

  it("rejects malformed bundles", () => {
    expect(() => decryptSecret("not-a-bundle")).toThrow();
    expect(() => decryptSecret("v2:a:b:c")).toThrow();
  });

  it("throws a helpful error when the key is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY/);
  });

  it("reports configured state", () => {
    expect(isEncryptionConfigured()).toBe(true);
  });

  it("masks secrets without revealing them", () => {
    const masked = maskSecret("xkeysib-1234567890abcd");
    expect(masked.endsWith("abcd")).toBe(true);
    expect(masked).not.toContain("xkeysib-123456");
    expect(masked).toContain("•");
  });

  it("safeEqual compares correctly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
