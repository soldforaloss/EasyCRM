import { describe, expect, it } from "vitest";
import { computeInsights, topProductsFrom } from "./insights";

const NOW = new Date("2026-06-17T00:00:00Z");

describe("topProductsFrom", () => {
  it("aggregates quantities across orders and ranks by quantity", () => {
    const top = topProductsFrom([
      { lineItems: [{ title: "Tee", quantity: 2 }, { title: "Cap", quantity: 1 }] },
      { lineItems: [{ title: "Tee", quantity: 3 }] },
    ]);
    expect(top).toEqual([
      { title: "Tee", quantity: 5 },
      { title: "Cap", quantity: 1 },
    ]);
  });
  it("limits to top N and ignores empty titles", () => {
    const top = topProductsFrom(
      [{ lineItems: [{ title: "", quantity: 9 }, { title: "A", quantity: 1 }] }],
      5,
    );
    expect(top).toEqual([{ title: "A", quantity: 1 }]);
  });
});

describe("computeInsights", () => {
  it("computes AOV, recency, tenure and frequency", () => {
    const r = computeInsights(
      {
        amountSpent: 300,
        numberOfOrders: 3,
        customerSince: "2025-06-17T00:00:00Z", // 1 year before NOW
        firstOrderAt: "2026-01-01T00:00:00Z",
        lastOrderAt: "2026-06-01T00:00:00Z",
        orders: [{ lineItems: [{ title: "Tee", quantity: 1 }] }],
      },
      NOW,
    );
    expect(r.aov).toBe(100);
    expect(r.daysSinceLastOrder).toBe(16); // Jun 1 -> Jun 17
    expect(r.tenureDays).toBe(365);
    // span Jan1->Jun1 = 151 days, /(3-1) = ~76
    expect(r.avgDaysBetweenOrders).toBe(76);
    expect(r.topProducts).toEqual([{ title: "Tee", quantity: 1 }]);
  });

  it("handles zero orders without dividing by zero", () => {
    const r = computeInsights(
      {
        amountSpent: 0,
        numberOfOrders: 0,
        customerSince: "2026-06-10T00:00:00Z",
        firstOrderAt: null,
        lastOrderAt: null,
        orders: [],
      },
      NOW,
    );
    expect(r.aov).toBe(0);
    expect(r.daysSinceLastOrder).toBeNull();
    expect(r.avgDaysBetweenOrders).toBeNull();
    expect(r.atRisk).toBe(false);
  });

  it("flags at-risk when the gap exceeds 2x the usual interval", () => {
    // avg interval ~30 days; last order 90 days ago -> at risk
    const r = computeInsights(
      {
        amountSpent: 200,
        numberOfOrders: 4,
        customerSince: "2025-01-01T00:00:00Z",
        firstOrderAt: "2026-01-01T00:00:00Z",
        lastOrderAt: "2026-03-19T00:00:00Z", // ~90 days before NOW
        orders: [],
      },
      NOW,
    );
    expect(r.avgDaysBetweenOrders).toBeGreaterThan(0);
    expect(r.daysSinceLastOrder).toBeGreaterThan(2 * (r.avgDaysBetweenOrders ?? 0));
    expect(r.atRisk).toBe(true);
  });

  it("does not flag at-risk for a recent, regular customer", () => {
    const r = computeInsights(
      {
        amountSpent: 200,
        numberOfOrders: 4,
        customerSince: "2025-01-01T00:00:00Z",
        firstOrderAt: "2026-04-01T00:00:00Z",
        lastOrderAt: "2026-06-15T00:00:00Z", // 2 days before NOW
        orders: [],
      },
      NOW,
    );
    expect(r.atRisk).toBe(false);
  });
});
