import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma client (shared across mirror.server + activity.server).
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    contact: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    activity: {
      create: vi.fn(),
    },
    processedOrder: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    visit: {
      upsert: vi.fn(),
    },
    contactLocation: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    shopSettings: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

// Avoid pulling the Shopify GraphQL module's transitive deps into the test.
const { syncFieldsMock } = vi.hoisted(() => ({ syncFieldsMock: vi.fn() }));
vi.mock("../shopify/customers.server", () => ({
  iterateCustomers: vi.fn(),
  fetchCustomerSyncFields: syncFieldsMock,
}));

const { recomputePreferencesMock } = vi.hoisted(() => ({
  recomputePreferencesMock: vi.fn(),
}));
vi.mock("./preferences.server", () => ({
  recomputeDerivedPreferences: recomputePreferencesMock,
}));

import {
  deleteContactFromWebhook,
  recordOrderAndRefresh,
  recordOrderFromWebhook,
  recordOrderWithVisit,
  refreshContactFromShopify,
  upsertContactFromWebhook,
} from "./mirror.server";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
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
  it("records one POS visit and location rollup with the enriched local order", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1" });
    prismaMock.processedOrder.create.mockResolvedValue({ id: "p1" }); // lock acquired
    prismaMock.shopSettings.findUnique.mockResolvedValue({ ianaTimezone: "America/Phoenix" });

    await recordOrderFromWebhook("s", {
      id: 1001,
      name: "#1001",
      total_price: "50.00",
      currency: "USD",
      created_at: "2026-06-01T00:00:00Z",
      source_name: "pos",
      location_id: 55,
      user_id: 77,
      device_id: 88,
      line_items: [
        {
          title: "Oxford Shirt",
          quantity: 2,
          variant_title: "Large",
          sku: "OX-L",
          product_id: 999,
          price: "25.00",
        },
      ],
      customer: { id: 123, email: "a@b.com" },
    });

    expect(prismaMock.processedOrder.create).toHaveBeenCalledTimes(1);
    const order = prismaMock.processedOrder.create.mock.calls[0][0].data;
    expect(order).toMatchObject({
      orderGid: "gid://shopify/Order/1001",
      orderName: "#1001",
      total: "50.00",
      currencyCode: "USD",
      sourceName: "pos",
      locationId: "55",
      posUserId: "77",
      posDeviceId: "88",
    });
    expect(JSON.parse(order.lineItems)).toEqual([
      {
        title: "Oxford Shirt",
        quantity: 2,
        variantTitle: "Large",
        sku: "OX-L",
        productId: "999",
      },
    ]);
    expect(prismaMock.visit.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.visit.upsert.mock.calls[0][0].create).toMatchObject({
      locationId: "55",
      visitDate: "2026-05-31",
      source: "POS_ORDER",
    });
    expect(prismaMock.contactLocation.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.contactLocation.upsert.mock.calls[0][0].update.ordersCount).toEqual({
      increment: 1,
    });
    expect(prismaMock.contact.update).toHaveBeenCalledTimes(1);
    const upd = prismaMock.contact.update.mock.calls[0][0];
    expect(upd.data.ordersCount).toEqual({ increment: 1 });
    expect(upd.data.amountSpent).toEqual({ increment: 50 });
    expect(prismaMock.activity.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activity.create.mock.calls[0][0].data.type).toBe("ORDER_PLACED");
    expect(recomputePreferencesMock).toHaveBeenCalledWith("s", "c1", prismaMock);
  });

  it("is idempotent: a duplicate delivery is a complete no-op", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1" });
    prismaMock.processedOrder.create.mockRejectedValue({ code: "P2002" });

    const admin = { graphql: vi.fn() };
    await recordOrderAndRefresh(admin, "s", {
      id: 1001,
      total_price: "50.00",
      created_at: "2026-06-01T00:00:00Z",
      source_name: "pos",
      location_id: 55,
      customer: { id: 123 },
    });

    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.activity.create).not.toHaveBeenCalled();
    expect(prismaMock.visit.upsert).not.toHaveBeenCalled();
    expect(prismaMock.contactLocation.upsert).not.toHaveBeenCalled();
    expect(syncFieldsMock).not.toHaveBeenCalled();
    expect(recomputePreferencesMock).not.toHaveBeenCalled();
  });

  it("guards lastOrderAt with a monotonic database update", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1" });
    prismaMock.processedOrder.create.mockResolvedValue({ id: "p2" });

    await recordOrderFromWebhook("s", {
      id: 999,
      total_price: "20.00",
      created_at: "2026-06-01T00:00:00Z", // older than the stored lastOrderAt
      customer: { id: 123 },
    });

    expect(prismaMock.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "c1",
        OR: [
          { lastOrderAt: null },
          { lastOrderAt: { lt: new Date("2026-06-01T00:00:00Z") } },
        ],
      },
      data: { lastOrderAt: new Date("2026-06-01T00:00:00Z") },
    });
    expect(prismaMock.contact.update.mock.calls[0][0].data.ordersCount).toEqual({ increment: 1 });
  });

  it("records online order enrichment without creating a visit", async () => {
    prismaMock.contact.upsert.mockResolvedValue({ id: "c1" });
    prismaMock.processedOrder.create.mockResolvedValue({ id: "p3" });

    await recordOrderFromWebhook("s", {
      id: 1002,
      name: "#1002",
      total_price: "35.00",
      currency: "USD",
      created_at: "2026-06-02T00:00:00Z",
      source_name: "web",
      location_id: null,
      line_items: [{ title: "Hat", quantity: 1, sku: "HAT" }],
      customer: { id: 123 },
    });

    expect(prismaMock.processedOrder.create.mock.calls[0][0].data).toMatchObject({
      sourceName: "web",
      locationId: null,
      total: "35.00",
    });
    expect(prismaMock.visit.upsert).not.toHaveBeenCalled();
    expect(prismaMock.contactLocation.upsert).not.toHaveBeenCalled();
  });

  it("backfill enriches only null legacy fields and repairs the missing POS rollup", async () => {
    prismaMock.processedOrder.create.mockRejectedValue({ code: "P2002" });
    prismaMock.processedOrder.findUnique.mockResolvedValue({
      id: "p1",
      orderName: "#keep",
      total: null,
      currencyCode: null,
      occurredAt: null,
      sourceName: null,
      locationId: null,
      posUserId: null,
      posDeviceId: null,
      lineItems: null,
    });
    prismaMock.processedOrder.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ ianaTimezone: "America/Phoenix" });

    const result = await recordOrderWithVisit(
      {
        shop: "s",
        orderGid: "gid://shopify/Order/1",
        contactId: "c1",
        orderName: "#new",
        total: "40.00",
        currencyCode: "USD",
        occurredAt: new Date("2026-06-01T00:00:00Z"),
        sourceName: "pos",
        locationId: "55",
        posUserId: null,
        posDeviceId: null,
        lineItems: [],
      },
      { enrichExisting: true },
    );

    expect(result).toBe("enriched");
    const update = prismaMock.processedOrder.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: "p1", locationId: null });
    expect(update.data.orderName).toBeUndefined();
    expect(update.data).toMatchObject({
      total: "40.00",
      currencyCode: "USD",
      sourceName: "pos",
      locationId: "55",
      lineItems: "[]",
    });
    expect(prismaMock.visit.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.contactLocation.upsert).toHaveBeenCalledTimes(1);
    expect(recomputePreferencesMock).not.toHaveBeenCalled();
  });

  it("recomputes preferences when backfill adds line items to a legacy order", async () => {
    prismaMock.processedOrder.create.mockRejectedValue({ code: "P2002" });
    prismaMock.processedOrder.findUnique.mockResolvedValue({
      id: "p2",
      orderName: null,
      total: null,
      currencyCode: null,
      occurredAt: null,
      sourceName: null,
      locationId: null,
      posUserId: null,
      posDeviceId: null,
      lineItems: null,
    });
    prismaMock.processedOrder.updateMany.mockResolvedValue({ count: 1 });

    const result = await recordOrderWithVisit(
      {
        shop: "s",
        orderGid: "gid://shopify/Order/2",
        contactId: "c1",
        orderName: "#2",
        total: "20.00",
        currencyCode: "USD",
        occurredAt: new Date("2026-06-02T00:00:00Z"),
        sourceName: "web",
        locationId: null,
        posUserId: null,
        posDeviceId: null,
        lineItems: [
          {
            title: "Sneaker",
            quantity: 1,
            variantTitle: "10 / White",
            sku: null,
            productId: null,
          },
        ],
      },
      { enrichExisting: true },
    );

    expect(result).toBe("enriched");
    expect(recomputePreferencesMock).toHaveBeenCalledWith("s", "c1", prismaMock);
  });

  it("skips guest checkouts (no customer)", async () => {
    await recordOrderFromWebhook("s", { id: 7, total_price: "10.00", customer: null });
    expect(prismaMock.contact.upsert).not.toHaveBeenCalled();
    expect(prismaMock.processedOrder.create).not.toHaveBeenCalled();
  });
});

describe("refreshContactFromShopify (consent)", () => {
  const admin = { graphql: vi.fn() };

  it("writes the current marketing states onto the mirror", async () => {
    syncFieldsMock.mockResolvedValue({
      amountSpent: 250,
      currencyCode: "USD",
      numberOfOrders: 3,
      lastOrderAt: "2026-01-01T00:00:00Z",
      emailMarketingState: "SUBSCRIBED",
      smsMarketingState: "NOT_SUBSCRIBED",
    });

    await refreshContactFromShopify(admin, "s", "gid://shopify/Customer/1");

    const data = prismaMock.contact.updateMany.mock.calls[0][0].data;
    expect(data.emailMarketingState).toBe("SUBSCRIBED");
    expect(data.smsMarketingState).toBe("NOT_SUBSCRIBED");
  });

  it("clears consent back to null when the customer opts out", async () => {
    // Consent must be written unconditionally: if an opt-out were spread-guarded away, a
    // previously-granted consent would persist forever and we would keep messaging them.
    syncFieldsMock.mockResolvedValue({
      amountSpent: 0,
      currencyCode: null,
      numberOfOrders: 0,
      lastOrderAt: null,
      emailMarketingState: null,
      smsMarketingState: null,
    });

    await refreshContactFromShopify(admin, "s", "gid://shopify/Customer/1");

    const data = prismaMock.contact.updateMany.mock.calls[0][0].data;
    expect(data).toHaveProperty("emailMarketingState", null);
    expect(data).toHaveProperty("smsMarketingState", null);
  });

  it("leaves the mirror untouched when the live read fails", async () => {
    syncFieldsMock.mockRejectedValue(new Error("rate limited"));
    await refreshContactFromShopify(admin, "s", "gid://shopify/Customer/1");
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });
});
