import { describe, expect, it } from "vitest";
import { orderWindowCutoff, summarizeLineItems } from "./orders";

describe("orderWindowCutoff", () => {
  it("uses the shop-local day across a UTC rollover", () => {
    const lateEveningPhoenix = new Date("2026-01-01T01:30:00.000Z");

    expect(
      orderWindowCutoff(
        lateEveningPhoenix,
        "1",
        "America/Phoenix",
      )?.toISOString(),
    ).toBe("2025-12-31T07:00:00.000Z");
    expect(
      orderWindowCutoff(lateEveningPhoenix, "1", "UTC")?.toISOString(),
    ).toBe("2026-01-01T00:00:00.000Z");
  });

  it("includes today and the preceding days, or returns no cutoff for all", () => {
    const now = new Date("2026-06-08T18:00:00.000Z");

    expect(orderWindowCutoff(now, "7", "America/Phoenix")?.toISOString()).toBe(
      "2026-06-02T07:00:00.000Z",
    );
    expect(orderWindowCutoff(now, "all", "America/Phoenix")).toBeNull();
  });
});

describe("summarizeLineItems", () => {
  it("formats item titles and quantities", () => {
    expect(
      summarizeLineItems(
        JSON.stringify([{ title: "Oxford Shirt", quantity: 2 }]),
      ),
    ).toBe("Oxford Shirt x2");
  });

  it("returns a dash for empty items", () => {
    expect(summarizeLineItems("[]")).toBe("—");
    expect(summarizeLineItems(null)).toBe("—");
  });

  it("returns a dash for malformed JSON", () => {
    expect(summarizeLineItems("not-json")).toBe("—");
  });

  it("shows two items and the remaining count", () => {
    expect(
      summarizeLineItems(
        JSON.stringify([
          { title: "Shirt", quantity: 1 },
          { title: "Sneakers", quantity: 2 },
          { title: "Hat", quantity: 1 },
          { title: "Socks", quantity: 3 },
        ]),
      ),
    ).toBe("Shirt x1, Sneakers x2, +2 more");
  });
});
