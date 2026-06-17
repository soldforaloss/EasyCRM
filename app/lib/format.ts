/**
 * Small, pure formatting helpers shared by UI and message rendering.
 * No DB / env / Shopify imports — safe everywhere.
 */

/** Format a numeric amount as money. Falls back gracefully on unknown currency codes. */
export function formatMoney(
  amount: number | null | undefined,
  currencyCode?: string | null,
): string {
  const value = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  const currency = currencyCode || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    // Unknown/invalid currency code — show the amount with the code suffix.
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Parse a Shopify Money string ("123.45") into a number for the mirror cache. */
export function parseMoney(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Format an ISO/date value as a short human date, e.g. "Jun 1, 2026". */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

/** Format a date with time, e.g. "Jun 1, 2026, 3:24 PM". */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** Compact relative-ish label for timelines ("Today", "Yesterday", or a date). */
export function formatRelativeDay(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor(
    (startOfToday.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return `${diffDays} days ago`;
  return formatDate(d);
}

/** Display name from optional first/last with a fallback. */
export function displayName(
  firstName?: string | null,
  lastName?: string | null,
  fallback = "Unnamed contact",
): string {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name || fallback;
}

/** Initials for an avatar from optional first/last. */
export function initials(firstName?: string | null, lastName?: string | null): string {
  const f = (firstName || "").trim();
  const l = (lastName || "").trim();
  const result = `${f.charAt(0)}${l.charAt(0)}`.toUpperCase();
  return result || "?";
}
