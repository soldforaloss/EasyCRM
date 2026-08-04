import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    processedOrder: { findMany: vi.fn() },
    contactPreference: { upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

import { recomputeDerivedPreferences } from "./preferences.server";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.contactPreference.upsert.mockResolvedValue({});
  prismaMock.contactPreference.deleteMany.mockResolvedValue({ count: 0 });
});

describe("recomputeDerivedPreferences", () => {
  it("upserts current derived values and deletes derived keys that went stale", async () => {
    prismaMock.processedOrder.findMany.mockResolvedValue([
      {
        lineItems: JSON.stringify([
          { title: "Old tee", variantTitle: "M / Black", quantity: 1 },
          { title: "Sneaker", variantTitle: "9.5W / White", quantity: 2 },
        ]),
      },
      {
        lineItems: JSON.stringify([
          { title: "New tee", variantTitle: "L / Blue", quantity: 3 },
        ]),
      },
      { lineItems: "not-json" },
    ]);

    await recomputeDerivedPreferences("shop.myshopify.com", "contact-1");

    expect(prismaMock.processedOrder.findMany).toHaveBeenCalledWith({
      where: { shop: "shop.myshopify.com", contactId: "contact-1" },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      select: { lineItems: true },
    });
    expect(prismaMock.contactPreference.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.contactPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { value: "L", sampleCount: 3 },
        create: expect.objectContaining({
          key: "SHIRT_SIZE",
          value: "L",
          source: "DERIVED",
          sampleCount: 3,
        }),
      }),
    );
    expect(prismaMock.contactPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { value: "9.5", sampleCount: 2 },
        create: expect.objectContaining({
          key: "SHOE_SIZE",
          value: "9.5",
          source: "DERIVED",
          sampleCount: 2,
        }),
      }),
    );
    expect(prismaMock.contactPreference.deleteMany).toHaveBeenCalledWith({
      where: {
        shop: "shop.myshopify.com",
        contactId: "contact-1",
        source: "DERIVED",
        key: { notIn: ["SHIRT_SIZE", "SHOE_SIZE"] },
      },
    });
  });

  it("removes all derived rows when order history has no recognizable sizes", async () => {
    prismaMock.processedOrder.findMany.mockResolvedValue([
      {
        lineItems: JSON.stringify([
          { title: "Jeans", variantTitle: "30 / 32", quantity: 1 },
        ]),
      },
    ]);

    await recomputeDerivedPreferences("shop.myshopify.com", "contact-1");

    expect(prismaMock.contactPreference.upsert).not.toHaveBeenCalled();
    expect(prismaMock.contactPreference.deleteMany).toHaveBeenCalledWith({
      where: {
        shop: "shop.myshopify.com",
        contactId: "contact-1",
        source: "DERIVED",
      },
    });
  });
});
