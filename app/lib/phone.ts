/**
 * E.164 phone normalization & validation for Brevo SMS (see DECISIONS.md §7).
 *
 * Pure and dependency-free so it is fully unit-testable and offline-installable.
 * `libphonenumber-js` is the recommended upgrade for exhaustive national-format parsing;
 * this implementation handles the common cases (already-E.164, `00` international prefix,
 * separators/spaces, and an optional default country calling code).
 *
 * E.164: a leading "+" followed by 8–15 digits, the first of which is non-zero.
 */

export interface PhoneOk {
  ok: true;
  e164: string;
}
export interface PhoneError {
  ok: false;
  reason: string;
}
export type PhoneResult = PhoneOk | PhoneError;

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Strict check that a string is already valid E.164. */
export function isValidE164(value: string | null | undefined): boolean {
  return typeof value === "string" && E164_RE.test(value);
}

/** Remove spaces, dashes, dots, parentheses and non-breaking spaces. */
function stripFormatting(input: string): string {
  return input.replace(/[\s\-(). ]/g, "");
}

/**
 * Normalize arbitrary phone input to E.164.
 *
 * @param input            raw phone string (may be null/empty)
 * @param defaultCallingCode  optional digits-only country calling code (e.g. "1", "44")
 *                            used only when the input has no "+"/"00" international prefix.
 */
export function normalizeE164(
  input: string | null | undefined,
  defaultCallingCode?: string | null,
): PhoneResult {
  if (input == null || String(input).trim() === "") {
    return { ok: false, reason: "No phone number provided." };
  }

  let s = stripFormatting(String(input).trim());

  // International access prefix "00" → "+".
  if (s.startsWith("00")) {
    s = `+${s.slice(2)}`;
  }

  if (!s.startsWith("+")) {
    const cc = (defaultCallingCode || "").replace(/[^\d]/g, "");
    if (!cc) {
      return {
        ok: false,
        reason:
          "Phone number is not in international format and no default country code is set.",
      };
    }
    // Drop a single leading national trunk "0" if present (common in many countries).
    const national = s.replace(/^0+/, "");
    s = `+${cc}${national}`;
  }

  // After the "+", everything must be digits.
  const digits = s.slice(1);
  if (!/^\d+$/.test(digits)) {
    return { ok: false, reason: "Phone number contains invalid characters." };
  }
  if (!E164_RE.test(s)) {
    return {
      ok: false,
      reason: "Phone number is not a valid E.164 number (expected 8–15 digits).",
    };
  }

  return { ok: true, e164: s };
}
