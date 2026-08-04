/** Format an instant as a calendar date in the shop timezone. */
export function dateStringInTz(date: Date, tz: string | null): string {
  return new Intl.DateTimeFormat("en-CA", {
    ...(tz ? { timeZone: tz } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
