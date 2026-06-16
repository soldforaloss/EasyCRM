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
      findFirst: vi.fn(),
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
  it("maps webhook fields and upserts by (shop, gid)", async () => {
    await upsertContactFromWebhook("shop.myshopify.com", {
      id: 123,
      email: "a@b.com",
      first_name: "Ada",
      last_name: "Byron",
      phone: "+15551234567",
      total_spent: "240.50",
      orders_count: 3,
      currency: "USD",
    });
    expect(prismaMock.contact.upsert).toHaveBeenCalledTimes(1);
    const arg = prismaMock.contact.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      shop_shopifyCustomerId: {
        shop: "shop.myshopify.com",
        shopifyCustomerId: "gid://shopify/Customer/123",
      },
    });
    expect(arg.update.amountSpent).toBe(240.5);
    expect(arg.update.ordersCount).toBe(3);
    expect(arg.update.email).toBe("a@b.com");
    expect(arg.create.shopifyCustomerId).toBe("gid://shopify/Customer/123");
  });

  it("prefers admin_graphql_api_id and omits spend when absent", async () => {
    await upsertContactFromWebhook("s", {
      id: 9,
      admin_graphql_api_id: "gid://shopify/Customer/9",
      email: "x@y.com",
    });
    const arg = prismaMock.contact.upsert.mock.calls[0][0];
    expect(arg.where.shop_shopifyCustomerId.shopifyCustomerId).toBe(
      "gid://shopify/Customer/9",
    );
    expect("amountSpent" in arg.update).toBe(false);
    expect("ordersCount" in arg.update).toBe(false);
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
  it("records a new order: increments spend and logs an ORDER_PLACED activity", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1" });
    prismaMock.activity.findFirst.mockResolvedValue(null); // not a duplicate

    await recordOrderFromWebhook("s", {
      id: 1001,
      name: "#1001",
      total_price: "50.00",
      currency: "USD",
      created_at: "2026-06-01T00:00:00Z",
      customer: { id: 123, email: "a@b.com" },
    });

    expect(prismaMock.contact.update).toHaveBeenCalledTimes(1);
    const upd = prismaMock.contact.update.mock.calls[0][0];
    expect(upd.data.ordersCount).toEqual({ increment: 1 });
    expect(upd.data.amountSpent).toEqual({ increment: 50 });
    expect(prismaMock.activity.create).toHaveBeenCalledTimes(1);
    const act = prismaMock.activity.create.mock.calls[0][0];
    expect(act.data.type).toBe("ORDER_PLACED");
  });

  it("is idempotent: a duplicate order delivery is ignored", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1" });
    prismaMock.activity.findFirst.mockResolvedValue({ id: "existing" });

    await recordOrderFromWebhook("s", {
      id: 1001,
      total_price: "50.00",
      customer: { id: 123 },
    });

    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(prismaMock.activity.create).not.toHaveBeenCalled();
  });

  it("skips guest checkouts (no customer)", async () => {
    await recordOrderFromWebhook("s", { id: 7, total_price: "10.00", customer: null });
    expect(prismaMock.contact.upsert).not.toHaveBeenCalled();
  });
});
