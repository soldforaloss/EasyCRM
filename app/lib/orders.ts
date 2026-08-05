import { dateStringInTz } from "./timezone";

export type OrderWindowDays = "1" | "7" | "30" | "all";

function dateParts(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function localDateStart(date: string, timezone: string | null): Date {
  const [year, month, day] = dateParts(date);
  if (!timezone) return new Date(year, month - 1, day);

  const target = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let candidate = target;

  // Convert the formatted wall-clock time back to an offset, then refine once for DST boundaries.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const formattedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const next = target - (formattedAsUtc - candidate);
    if (next === candidate) break;
    candidate = next;
  }

  return new Date(candidate);
}

/** Start of an inclusive order window, measured in shop-local calendar days. */
export function orderWindowCutoff(
  now: Date,
  days: OrderWindowDays,
  timezone: string | null,
): Date | null {
  if (days === "all") return null;
  const [year, month, day] = dateParts(dateStringInTz(now, timezone));
  const firstDay = new Date(
    Date.UTC(year, month - 1, day - (Number(days) - 1)),
  );
  return localDateStart(dateStringInTz(firstDay, "UTC"), timezone);
}

/** Render up to two validated line items from the local JSON-as-String order record. */
export function summarizeLineItems(value: string | null | undefined): string {
  if (!value) return "—";

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return "—";
    const items = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { title, quantity } = item as {
        title?: unknown;
        quantity?: unknown;
      };
      if (
        typeof title !== "string" ||
        !title.trim() ||
        typeof quantity !== "number" ||
        !Number.isFinite(quantity) ||
        quantity <= 0
      ) {
        return [];
      }
      return [`${title.trim()} x${quantity}`];
    });
    if (items.length === 0) return "—";
    const remaining = items.length - 2;
    return `${items.slice(0, 2).join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}`;
  } catch {
    return "—";
  }
}
