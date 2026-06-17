import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma client (shared across mirror.server + activity.server).
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    contact: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    activity: {
      create: vi.fn(),
    },
    processedOrder: {
      create: vi.fn(),
    },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

// Avoid pulling the Shopify GraphQL module's transitive deps into the test.
vi.mock("../shopify/customers.server", () => ({ iterateCustomers: vi.fn() }));

import {
  deleteContactFromWebhook,
  recordOrderFromWebhook,
  upsertContactFromWebhook,
} from "./mirror.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertContactFromWebhook", () => {
  it("mirrors identity fields and upserts by (shop, gid)", async () => {
    await upsertContactFromWebhook("shop.myshopify.com", {
      id: 123,
      email: "a@b.com",
      first_name: "Ada",
      last_name: "Byron",
      phone: "+15551234567",
    });
    expect(prismaMock.contact.upsert).toHaveBeenCalledTimes(1);
    const arg = prismaMock.contact.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      shop_shopifyCustomerId: {
        shop: "shop.myshopify.com",
        shopifyCustomerId: "gid://shopify/Customer/123",
      },
    });
    expect(arg.update.email).toBe("a@b.com");
    expect(arg.update.firstName).toBe("Ada");
    expect(arg.create.shopifyCustomerId).toBe("gid://shopify/Customer/123");
  });

  it("never writes spend signals from the customer webhook (removed from payload 2025-01+)", async () => {
    // Even if a legacy payload carried these, the mirror must not write them (would drift vs increments).
    await upsertContactFromWebhook("s", {
      id: 9,
      admin_graphql_api_id: "gid://shopify/Customer/9",
      email: "x@y.com",
      total_spent: "999.00",
      orders_count: 7,
    });
    const arg = prismaMock.contact.upsert.mock.calls[0][0];
    expect(arg.where.shop_shopifyCustomerId.shopifyCustomerId).toBe(
      "gid://shopify/Customer/9",
    );
    expect("amountSpent" in arg.update).toBe(false);
    expect("ordersCount" in arg.update).toBe(false);
    expect("currencyCode" in arg.update).toBe(false);
  });

  it("does nothing without an id", async () => {
    await upsertContactFromWebhook("s", { email: "no-id@x.com" });
    expect(prismaMock.contact.upsert).not.toHaveBeenCalled();
  });
});

describe("deleteContactFromWebhook", () => {
  it("deletes by shop + gid (idempotent)", async () => {
    await deleteContactFromWebhook("s", { id: 5 });
    expect(prismaMock.contact.deleteMany).toHaveBeenCalledWith({
      where: { shop: "s", shopifyCustomerId: "gid://shopify/Customer/5" },
    });
  });
});

describe("recordOrderFromWebhook", () => {
  it("records a new order: takes the dedup lock, increments spend, logs ORDER_PLACED", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1", lastOrderAt: null });
    prismaMock.processedOrder.create.mockResolvedValue({ id: "p1" }); // lock acquired

    await recordOrderFromWebhook("s", {
      id: 1001,
      name: "#1001",
      total_price: "50.00",
      currency: "USD",
      created_at: "2026-06-01T00:00:00Z",
      customer: { id: 123, email: "a@b.com" },
    });

    expect(prismaMock.processedOrder.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.processedOrder.create.mock.calls[0][0].data.orderGid).toBe(
      "gid://shopify/Order/1001",
    );
    expect(prismaMock.contact.update).toHaveBeenCalledTimes(1);
    const upd = prismaMock.contact.update.mock.calls[0][0];
    expect(upd.data.ordersCount).toEqual({ increment: 1 });
    expect(upd.data.amountSpent).toEqual({ increment: 50 });
    expect(upd.data.lastOrderAt).toBeInstanceOf(Date); // advanced from null
    expect(prismaMock.activity.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activity.create.mock.calls[0][0].data.type).toBe("ORDER_PLACED");
  });

  it("is idempotent: a duplicate delivery (P2002 on the lock) is ignored", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1", lastOrderAt: null });
    prismaMock.processedOrder.create.mockRejectedValue({ code: "P2002" });

    await recordOrderFromWebhook("s", {
      id: 1001,
      total_price: "50.00",
      customer: { id: 123 },
    });

    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(prismaMock.activity.create).not.toHaveBeenCalled();
  });

  it("does not regress lastOrderAt for an older out-of-order delivery", async () => {
    prismaMock.contact.upsert.mockResolvedValue({
      id: "c1",
      lastOrderAt: new Date("2026-06-10T00:00:00Z"),
    });
    prismaMock.processedOrder.create.mockResolvedValue({ id: "p2" });

    await recordOrderFromWebhook("s", {
      id: 999,
      total_price: "20.00",
      created_at: "2026-06-01T00:00:00Z", // older than the stored lastOrderAt
      customer: { id: 123 },
    });

    const upd = prismaMock.contact.update.mock.calls[0][0];
    expect("lastOrderAt" in upd.data).toBe(false); // not advanced backwards
    expect(upd.data.ordersCount).toEqual({ increment: 1 }); // still counted
  });

  it("skips guest checkouts (no customer)", async () => {
    await recordOrderFromWebhook("s", { id: 7, total_price: "10.00", customer: null });
    expect(prismaMock.contact.upsert).not.toHaveBeenCalled();
  });
});
