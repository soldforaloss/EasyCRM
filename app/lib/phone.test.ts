import { describe, expect, it } from "vitest";
import { isValidE164, normalizeE164 } from "./phone";

describe("phone.isValidE164", () => {
  it("accepts valid E.164", () => {
    expect(isValidE164("+15551234567")).toBe(true);
    expect(isValidE164("+447911123456")).toBe(true);
  });
  it("rejects invalid", () => {
    expect(isValidE164("5551234567")).toBe(false); // no +
    expect(isValidE164("+0123456789")).toBe(false); // leading zero after +
    expect(isValidE164("+1")).toBe(false); // too short
    expect(isValidE164("")).toBe(false);
    expect(isValidE164(null)).toBe(false);
  });
});

describe("phone.normalizeE164", () => {
  it("passes through already-valid E.164", () => {
    expect(normalizeE164("+15551234567")).toEqual({
      ok: true,
      e164: "+15551234567",
    });
  });

  it("strips formatting characters", () => {
    expect(normalizeE164("+1 (555) 123-4567")).toEqual({
      ok: true,
      e164: "+15551234567",
    });
    expect(normalizeE164("+44 7911 123 456")).toEqual({
      ok: true,
      e164: "+447911123456",
    });
  });

  it("converts a 00 international prefix to +", () => {
    expect(normalizeE164("0044 7911 123456")).toEqual({
      ok: true,
      e164: "+447911123456",
    });
  });

  it("applies a default calling code and drops the national trunk 0", () => {
    expect(normalizeE164("07911 123456", "44")).toEqual({
      ok: true,
      e164: "+447911123456",
    });
    expect(normalizeE164("(555) 123-4567", "1")).toEqual({
      ok: true,
      e164: "+15551234567",
    });
  });

  it("fails with no international format and no default code", () => {
    const r = normalizeE164("5551234567");
    expect(r.ok).toBe(false);
  });

  it("fails on empty / missing input", () => {
    expect(normalizeE164("").ok).toBe(false);
    expect(normalizeE164(null).ok).toBe(false);
    expect(normalizeE164(undefined).ok).toBe(false);
  });

  it("fails on letters", () => {
    expect(normalizeE164("+1555CALLNOW").ok).toBe(false);
  });

  it("fails when too long for E.164", () => {
    expect(normalizeE164("+1234567890123456").ok).toBe(false);
  });
});
