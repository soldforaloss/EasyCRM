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
  it("exports customer-relevant order fields without POS staff or persistence identifiers", async () => {
    await assembleCustomerData("shop.myshopify.com", "gid://shopify/Customer/1");

    const processedOrders = prismaMock.contact.findFirst.mock.calls[0][0].include.processedOrders;
    expect(prismaMock.contact.findFirst.mock.calls[0][0].include.preferences).toBe(true);
    expect(processedOrders.select).toMatchObject({
      orderGid: true,
      orderName: true,
      total: true,
      currencyCode: true,
      occurredAt: true,
      sourceName: true,
      locationId: true,
      lineItems: true,
      createdAt: true,
    });
    expect(processedOrders.select).not.toHaveProperty("posUserId");
    expect(processedOrders.select).not.toHaveProperty("posDeviceId");
    expect(processedOrders.select).not.toHaveProperty("contactId");
    expect(processedOrders.select).not.toHaveProperty("shop");
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
