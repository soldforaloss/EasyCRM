import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    contact: { findFirst: vi.fn(), findMany: vi.fn() },
    activity: { findMany: vi.fn(), create: vi.fn() },
    messageLog: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

const { settingsMock } = vi.hoisted(() => ({
  settingsMock: {
    brevoApiKeyEncrypted: "cipher",
    brevoConnected: true,
    brevoSenderEmail: "shop@store.com",
    brevoSenderName: "Store",
    brevoSmsSender: "Store",
    businessAddress: "Store Ltd, 1 Example St, Phoenix AZ",
    unsubscribeUrl: "https://store.com/unsubscribe",
  },
}));

// Stub the sender preflight so we don't need real encryption/Brevo-account lookups.
vi.mock("./settings.server", () => ({
  getOrCreateSettings: vi.fn(async () => settingsMock),
  getDecryptedBrevoKey: vi.fn(async () => "KEY"),
}));

import { checkEligibility, sendToContact } from "./messaging.server";

/** A fully consented contact — the only kind that may be messaged. */
const baseContact = {
  id: "c1",
  shop: "s",
  shopifyCustomerId: "gid://shopify/Customer/1",
  firstName: "Ada",
  lastName: "Byron",
  email: "ada@example.com",
  phone: "+15551234567",
  emailMarketingState: "SUBSCRIBED",
  smsMarketingState: "SUBSCRIBED",
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

/** The data passed to the terminal messageLog.update call. */
function finalizedLog() {
  const calls = prismaMock.messageLog.update.mock.calls;
  return calls[calls.length - 1][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  prismaMock.activity.findMany.mockResolvedValue([]); // no last-order activities
  prismaMock.messageLog.create.mockResolvedValue({ id: "log1" });
  prismaMock.messageLog.update.mockResolvedValue({ id: "log1" });
  prismaMock.activity.create.mockResolvedValue({});
  settingsMock.businessAddress = "Store Ltd, 1 Example St, Phoenix AZ";
});

/* ------------------------------------------------------------------ */
/* The consent gate — the highest-consequence behavior in the app.     */
/* ------------------------------------------------------------------ */

describe("consent gate", () => {
  const nonConsenting = [
    "NOT_SUBSCRIBED",
    "PENDING",
    "UNSUBSCRIBED",
    "REDACTED",
    "INVALID",
    null,
  ];

  it.each(nonConsenting)("refuses to send email when state is %s", async (state) => {
    prismaMock.contact.findFirst.mockResolvedValue({
      ...baseContact,
      emailMarketingState: state,
    });
    const fetchFn = stubFetch(201, { messageId: "x" });

    const outcome = await sendToContact("s", {
      contactId: "c1",
      channel: "EMAIL",
      subject: "Hi",
      body: "Body",
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("SKIPPED");
    expect(outcome.skipReason).toBe("NO_CONSENT");
    expect(finalizedLog().status).toBe("SKIPPED");
    expect(finalizedLog().skipReason).toBe("NO_CONSENT");
    // A suppressed send must not appear on the timeline as a sent message.
    expect(prismaMock.activity.create).not.toHaveBeenCalled();
  });

  it.each(nonConsenting)("refuses to send SMS when state is %s", async (state) => {
    prismaMock.contact.findFirst.mockResolvedValue({
      ...baseContact,
      smsMarketingState: state,
    });
    const fetchFn = stubFetch(201, { messageId: 1 });

    const outcome = await sendToContact("s", { contactId: "c1", channel: "SMS", body: "Hi" });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(outcome.skipReason).toBe("NO_CONSENT");
  });

  it("treats the channels independently — email consent does not authorize SMS", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({
      ...baseContact,
      emailMarketingState: "SUBSCRIBED",
      smsMarketingState: "UNSUBSCRIBED",
    });
    const fetchFn = stubFetch(201, { messageId: "m" });

    const email = await sendToContact("s", { contactId: "c1", channel: "EMAIL", body: "Hi" });
    expect(email.ok).toBe(true);

    const sms = await sendToContact("s", { contactId: "c1", channel: "SMS", body: "Hi" });
    expect(sms.skipReason).toBe("NO_CONSENT");

    // Exactly one network call — the email.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports NO_CONSENT rather than NO_ADDRESS when both are missing", async () => {
    // Ordering matters: a non-consented contact must never be recorded as merely unreachable,
    // because the two have different remedies.
    prismaMock.contact.findFirst.mockResolvedValue({
      ...baseContact,
      email: null,
      emailMarketingState: "UNSUBSCRIBED",
    });
    const outcome = await sendToContact("s", { contactId: "c1", channel: "EMAIL", body: "x" });
    expect(outcome.skipReason).toBe("NO_CONSENT");
  });
});

describe("checkEligibility", () => {
  it("passes a consented, reachable contact", () => {
    expect(checkEligibility("EMAIL", baseContact)).toBeNull();
    expect(checkEligibility("SMS", baseContact)).toBeNull();
  });

  it("flags a consented contact with no email address", () => {
    expect(checkEligibility("EMAIL", { ...baseContact, email: null })?.reason).toBe("NO_ADDRESS");
  });

  it("flags a consented contact with an unusable phone", () => {
    expect(checkEligibility("SMS", { ...baseContact, phone: "12345" })?.reason).toBe(
      "INVALID_PHONE",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Compliance furniture                                                */
/* ------------------------------------------------------------------ */

describe("marketing email compliance", () => {
  it("appends the postal address and unsubscribe link, and sets List-Unsubscribe headers", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(baseContact);
    const fetchFn = stubFetch(201, { messageId: "<m1@brevo>" });

    await sendToContact("s", { contactId: "c1", channel: "EMAIL", subject: "Hi", body: "Body" });

    const payload = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(payload.textContent).toContain("Store Ltd, 1 Example St, Phoenix AZ");
    expect(payload.textContent).toContain("https://store.com/unsubscribe");
    expect(payload.htmlContent).toContain("https://store.com/unsubscribe");
    expect(payload.headers["List-Unsubscribe"]).toBe("<https://store.com/unsubscribe>");
    expect(payload.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("blocks email entirely when no business address is configured", async () => {
    settingsMock.businessAddress = "";
    prismaMock.contact.findFirst.mockResolvedValue(baseContact);
    const fetchFn = stubFetch(201, {});

    const outcome = await sendToContact("s", { contactId: "c1", channel: "EMAIL", body: "Body" });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.error).toContain("business postal address");
  });

  it("marks contact SMS as marketing traffic to Brevo", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(baseContact);
    const fetchFn = stubFetch(201, { messageId: 9988 });

    await sendToContact("s", { contactId: "c1", channel: "SMS", body: "Hi" });

    expect(JSON.parse(fetchFn.mock.calls[0][1].body).type).toBe("marketing");
  });
});

/* ------------------------------------------------------------------ */
/* Happy paths                                                         */
/* ------------------------------------------------------------------ */

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

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/smtp/email");
    const payload = JSON.parse(init.body);
    expect(payload.subject).toBe("Hi Ada");
    expect(payload.textContent).toContain("Thanks Ada Byron!");

    expect(finalizedLog().status).toBe("SENT");
    expect(finalizedLog().providerMessageId).toBe("<m1@brevo>");
    expect(prismaMock.activity.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activity.create.mock.calls[0][0].data.type).toBe("EMAIL_SENT");
  });

  it("logs SKIPPED/NO_ADDRESS and does not call Brevo when a consented contact has no email", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ ...baseContact, email: null });
    const fetchFn = stubFetch(201, { messageId: "x" });

    const outcome = await sendToContact("s", {
      contactId: "c1",
      channel: "EMAIL",
      subject: "Hi",
      body: "Body",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.skipReason).toBe("NO_ADDRESS");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(finalizedLog().status).toBe("SKIPPED");
  });

  it("records a transport failure as FAILED, not SKIPPED", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(baseContact);
    stubFetch(400, { message: "bad sender" });

    const outcome = await sendToContact("s", { contactId: "c1", channel: "EMAIL", body: "Body" });

    expect(outcome.status).toBe("FAILED");
    expect(finalizedLog().status).toBe("FAILED");
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
    expect(finalizedLog().providerMessageId).toBe("9988");
  });

  it("logs SKIPPED for an invalid phone without calling Brevo", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ ...baseContact, phone: "12345" });
    const fetchFn = stubFetch(201, {});

    const outcome = await sendToContact("s", { contactId: "c1", channel: "SMS", body: "Hi" });

    expect(outcome.ok).toBe(false);
    expect(outcome.skipReason).toBe("INVALID_PHONE");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Bulk idempotency                                                    */
/* ------------------------------------------------------------------ */

describe("batch idempotency", () => {
  it("does not send when the (batch, contact) log row already exists", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(baseContact);
    // Simulate the unique (batchId, contactId) constraint rejecting a replayed job.
    prismaMock.messageLog.create.mockRejectedValue({ code: "P2002" });
    const fetchFn = stubFetch(201, { messageId: "x" });

    const outcome = await sendToContact("s", {
      contactId: "c1",
      channel: "EMAIL",
      body: "Body",
      batchId: "b1",
    });

    expect(outcome.status).toBe("DUPLICATE");
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
