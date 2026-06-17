import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    contact: { findFirst: vi.fn(), findMany: vi.fn() },
    activity: { findMany: vi.fn(), create: vi.fn() },
    messageLog: { create: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

// Stub the sender preflight so we don't need real encryption/Brevo-account lookups.
vi.mock("./settings.server", () => ({
  getOrCreateSettings: vi.fn(async () => ({
    brevoApiKeyEncrypted: "cipher",
    brevoConnected: true,
    brevoSenderEmail: "shop@store.com",
    brevoSenderName: "Store",
    brevoSmsSender: "Store",
  })),
  getDecryptedBrevoKey: vi.fn(async () => "KEY"),
}));

import { sendToContact } from "./messaging.server";

const baseContact = {
  id: "c1",
  shop: "s",
  shopifyCustomerId: "gid://shopify/Customer/1",
  firstName: "Ada",
  lastName: "Byron",
  email: "ada@example.com",
  phone: "+15551234567",
  ordersCount: 2,
  amountSpent: 100,
  currencyCode: "USD",
  lastOrderAt: null,
  lifecycleStage: "CUSTOMER",
};

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    void url;
    void init;
    return {
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  prismaMock.activity.findMany.mockResolvedValue([]); // no last-order activities
  prismaMock.messageLog.create.mockResolvedValue({ id: "log1" });
  prismaMock.activity.create.mockResolvedValue({});
});

describe("sendToContact (email)", () => {
  it("renders merge vars, calls Brevo, logs SENT and an EMAIL_SENT activity", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(baseContact);
    const fetchFn = stubFetch(201, { messageId: "<m1@brevo>" });

    const outcome = await sendToContact("s", {
      contactId: "c1",
      channel: "EMAIL",
      subject: "Hi {{firstName}}",
      body: "Thanks {{firstName}} {{lastName}}!",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("SENT");

    // Brevo email endpoint called with rendered content.
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/smtp/email");
    const payload = JSON.parse(init.body);
    expect(payload.subject).toBe("Hi Ada");
    expect(payload.textContent).toBe("Thanks Ada Byron!");

    // Logged as SENT with provider id, and an EMAIL_SENT activity recorded.
    const log = prismaMock.messageLog.create.mock.calls[0][0].data;
    expect(log.status).toBe("SENT");
    expect(log.providerMessageId).toBe("<m1@brevo>");
    expect(prismaMock.activity.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activity.create.mock.calls[0][0].data.type).toBe("EMAIL_SENT");
  });

  it("logs FAILED and does not call Brevo when the contact has no email", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ ...baseContact, email: null });
    const fetchFn = stubFetch(201, { messageId: "x" });

    const outcome = await sendToContact("s", {
      contactId: "c1",
      channel: "EMAIL",
      subject: "Hi",
      body: "Body",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("FAILED");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(prismaMock.messageLog.create.mock.calls[0][0].data.status).toBe("FAILED");
  });
});

describe("sendToContact (sms)", () => {
  it("normalizes the phone, strips +, and logs SENT", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(baseContact);
    const fetchFn = stubFetch(201, { messageId: 9988 });

    const outcome = await sendToContact("s", {
      contactId: "c1",
      channel: "SMS",
      body: "Hi {{firstName}}",
    });

    expect(outcome.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/transactionalSMS/send");
    const payload = JSON.parse(init.body);
    expect(payload.recipient).toBe("15551234567"); // no leading +
    expect(payload.content).toBe("Hi Ada");
    expect(prismaMock.messageLog.create.mock.calls[0][0].data.providerMessageId).toBe("9988");
  });

  it("logs FAILED for an invalid phone without calling Brevo", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ ...baseContact, phone: "12345" });
    const fetchFn = stubFetch(201, {});

    const outcome = await sendToContact("s", { contactId: "c1", channel: "SMS", body: "Hi" });

    expect(outcome.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("sendToContact (blocked)", () => {
  it("returns BLOCKED when the contact is not found", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);
    const outcome = await sendToContact("s", { contactId: "missing", channel: "EMAIL", body: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("BLOCKED");
  });
});
