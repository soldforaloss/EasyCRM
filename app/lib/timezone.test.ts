import { describe, expect, it } from "vitest";
import { dateStringInTz } from "./timezone";

describe("dateStringInTz", () => {
  it("uses the requested timezone for date rollover", () => {
    const instant = new Date("2026-01-01T01:30:00.000Z");

    expect(dateStringInTz(instant, "UTC")).toBe("2026-01-01");
    expect(dateStringInTz(instant, "America/Phoenix")).toBe("2025-12-31");
  });

  it("falls back to the server timezone when the shop timezone is null", () => {
    const instant = new Date("2026-08-04T23:30:00.000Z");
    const expected = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);

    expect(dateStringInTz(instant, null)).toBe(expected);
  });
});
