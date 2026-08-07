import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    contact: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    task: {
      deleteMany: vi.fn(),
    },
    dataRequest: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

import { assembleCustomerData, redactCustomer } from "./compliance.server";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.contact.findFirst.mockResolvedValue(null);
  prismaMock.contact.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.task.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.dataRequest.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.$transaction.mockResolvedValue([]);
});

describe("assembleCustomerData", () => {
  it("exports customer-facing fields without staff or persistence identifiers", async () => {
    const createdAt = new Date("2026-08-04T12:00:00.000Z");
    prismaMock.contact.findFirst.mockResolvedValue({
      shopifyCustomerId: "gid://shopify/Customer/1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "+15551234567",
      amountSpent: 120,
      currencyCode: "USD",
      ordersCount: 2,
      lastOrderAt: createdAt,
      lastVisitAt: createdAt,
      lastVisitLocationId: "101",
      lifecycleStage: "VIP",
      source: "POS",
      createdAt,
      updatedAt: createdAt,
      tags: [{ createdAt, tag: { name: "VIP" } }],
      notes: [{ body: "Prefers text", createdAt, updatedAt: createdAt }],
      activities: [{ type: "ORDER_PLACED", occurredAt: createdAt, createdAt }],
      tasks: [
        {
          title: "Follow up",
          notes: "Ask about sizing",
          dueAt: createdAt,
          status: "OPEN",
          createdAt,
          updatedAt: createdAt,
        },
      ],
      processedOrders: [
        {
          orderGid: "gid://shopify/Order/10",
          orderName: "#10",
          total: "120.00",
          currencyCode: "USD",
          occurredAt: createdAt,
          sourceName: "pos",
          locationId: "101",
          lineItems: '[{"title":"Sneaker"}]',
          createdAt,
        },
      ],
      visits: [
        {
          locationId: "101",
          visitDate: "2026-08-04",
          source: "POS_ORDER",
          orderGid: "gid://shopify/Order/10",
          createdAt,
        },
      ],
      contactLocations: [{ locationId: "101", ordersCount: 2, lastOrderAt: createdAt }],
      preferences: [
        { key: "SHOE_SIZE", value: "10", source: "DERIVED", sampleCount: 2, updatedAt: createdAt },
      ],
    });

    const exported = await assembleCustomerData(
      "shop.myshopify.com",
      "gid://shopify/Customer/1",
    );

    const selected = prismaMock.contact.findFirst.mock.calls[0][0].select;
    expect(selected).not.toHaveProperty("id");
    expect(selected).not.toHaveProperty("shop");
    expect(selected).not.toHaveProperty("ownerStaffId");
    expect(selected.notes.select).toEqual({ body: true, createdAt: true, updatedAt: true });
    expect(selected.tasks.select).toMatchObject({ title: true, notes: true, status: true });
    expect(selected.processedOrders.select).toMatchObject({
      orderGid: true,
      orderName: true,
      total: true,
      currencyCode: true,
      occurredAt: true,
      sourceName: true,
      locationId: true,
      lineItems: true,
    });
    expect(selected.visits.select).toMatchObject({ locationId: true, visitDate: true });
    expect(selected.contactLocations.select).toMatchObject({
      locationId: true,
      ordersCount: true,
      lastOrderAt: true,
    });
    expect(selected.preferences.select).toMatchObject({
      key: true,
      value: true,
      source: true,
      sampleCount: true,
    });

    const selectedKeyNames = JSON.stringify(selected).match(/"([^"]+)":/g) ?? [];
    expect(selectedKeyNames.filter((key) => /StaffId":$/.test(key))).toEqual([]);
    const keyNames = JSON.stringify(exported).match(/"([^"]+)":/g) ?? [];
    expect(keyNames.filter((key) => /StaffId":$/.test(key))).toEqual([]);
    expect(exported.data).toMatchObject({
      firstName: "Ada",
      tags: [{ tag: { name: "VIP" } }],
      notes: [{ body: "Prefers text" }],
      activities: [{ type: "ORDER_PLACED" }],
      tasks: [{ title: "Follow up", status: "OPEN" }],
      processedOrders: [{ orderName: "#10", total: "120.00", locationId: "101" }],
      visits: [{ locationId: "101", visitDate: "2026-08-04" }],
      contactLocations: [{ locationId: "101", ordersCount: 2 }],
      preferences: [{ key: "SHOE_SIZE", value: "10", source: "DERIVED" }],
    });
  });
});

describe("redactCustomer", () => {
  it("removes denormalized data-request exports even when no Contact remains", async () => {
    await redactCustomer("shop.myshopify.com", "gid://shopify/Customer/1");

    expect(prismaMock.dataRequest.deleteMany).toHaveBeenCalledWith({
      where: {
        shop: "shop.myshopify.com",
        shopifyCustomerId: "gid://shopify/Customer/1",
      },
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("atomically removes tasks, the Contact graph, and matching exports", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: "contact-1" });

    await redactCustomer("shop.myshopify.com", "gid://shopify/Customer/1");

    expect(prismaMock.task.deleteMany).toHaveBeenCalledWith({
      where: { shop: "shop.myshopify.com", contactId: "contact-1" },
    });
    expect(prismaMock.contact.deleteMany).toHaveBeenCalledWith({
      where: { shop: "shop.myshopify.com", id: "contact-1" },
    });
    expect(prismaMock.dataRequest.deleteMany).toHaveBeenCalledWith({
      where: {
        shop: "shop.myshopify.com",
        shopifyCustomerId: "gid://shopify/Customer/1",
      },
    });
    expect(prismaMock.$transaction.mock.calls[0][0]).toHaveLength(3);
  });
});
