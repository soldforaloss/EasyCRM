import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared Prisma mock (inbound.server + contacts.server + activity.server all import db.server).
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    contact: { findFirst: vi.fn() },
    messageLog: { create: vi.fn() },
    activity: { create: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

import {
  deriveChannel,
  extractSender,
  parseConversationFragment,
  recordInboundFragment,
} from "./inbound.server";

beforeEach(() => {
  vi.clearAllMocks();
});

const emailFragment = {
  eventName: "conversationFragment",
  conversationId: "conv1",
  visitor: { id: "v1", source: "email", attributes: { EMAIL: "ada@example.com" } },
  messages: [
    { id: "m1", type: "visitor", text: "Thanks!", createdAt: 1_700_000_000_000 },
    { id: "m2", type: "agent", text: "our outbound reply", createdAt: 1_700_000_001_000 },
  ],
};

const smsFragment = {
  conversationId: "conv2",
  visitor: { id: "v2", source: "sms", attributes: { SMS: "+15551234567" } },
  messages: [{ id: "s1", type: "visitor", text: "yes please", createdAt: 1_700_000_002_000 }],
};

describe("deriveChannel", () => {
  it("maps email/sms sources and skips chat/social/unknown", () => {
    expect(deriveChannel("email")).toBe("EMAIL");
    expect(deriveChannel("transactionalEmail")).toBe("EMAIL");
    expect(deriveChannel("sms")).toBe("SMS");
    expect(deriveChannel("text")).toBe("SMS");
    expect(deriveChannel("whatsapp")).toBeNull();
    expect(deriveChannel("widget")).toBeNull();
    expect(deriveChannel(undefined)).toBeNull();
  });
});

describe("extractSender", () => {
  it("pulls email and phone out of visitor.attributes", () => {
    expect(extractSender(emailFragment.visitor)).toEqual({
      email: "ada@example.com",
      phone: null,
    });
    expect(extractSender(smsFragment.visitor)).toEqual({
      email: null,
      phone: "+15551234567",
    });
    expect(extractSender(null)).toEqual({ email: null, phone: null });
  });
});

describe("parseConversationFragment", () => {
  it("keeps visitor (inbound) messages and drops agent (outbound) ones", () => {
    const parsed = parseConversationFragment(emailFragment);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      providerEventId: "m1",
      channel: "EMAIL",
      text: "Thanks!",
      senderEmail: "ada@example.com",
      conversationId: "conv1",
    });
    expect(parsed[0].createdAt).toBeInstanceOf(Date);
  });

  it("derives an SMS message with sender phone", () => {
    const parsed = parseConversationFragment(smsFragment);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ channel: "SMS", senderPhone: "+15551234567" });
  });

  it("returns [] for unknown channels and malformed input (never throws)", () => {
    expect(
      parseConversationFragment({
        visitor: { source: "whatsapp", attributes: {} },
        messages: [{ id: "x", type: "visitor", text: "hi" }],
      }),
    ).toEqual([]);
    expect(parseConversationFragment(null)).toEqual([]);
    expect(parseConversationFragment({})).toEqual([]);
  });
});

describe("recordInboundFragment", () => {
  it("stores a matched email reply as INBOUND and logs EMAIL_RECEIVED", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: "c1" });
    prismaMock.messageLog.create.mockResolvedValue({ id: "log1" });

    const result = await recordInboundFragment("s", emailFragment);

    expect(result).toEqual({ matched: 1, skipped: 0, duplicates: 0 });
    const data = prismaMock.messageLog.create.mock.calls[0][0].data;
    expect(data.direction).toBe("INBOUND");
    expect(data.channel).toBe("EMAIL");
    expect(data.providerEventId).toBe("m1");
    expect(data.contactId).toBe("c1");
    expect(prismaMock.activity.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activity.create.mock.calls[0][0].data.type).toBe("EMAIL_RECEIVED");
  });

  it("matches an SMS reply by normalized phone and logs SMS_RECEIVED", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: "c2" });
    prismaMock.messageLog.create.mockResolvedValue({ id: "log2" });

    const result = await recordInboundFragment("s", smsFragment);

    expect(result.matched).toBe(1);
    expect(prismaMock.messageLog.create.mock.calls[0][0].data.channel).toBe("SMS");
    expect(prismaMock.activity.create.mock.calls[0][0].data.type).toBe("SMS_RECEIVED");
  });

  it("is idempotent: a duplicate delivery (P2002) logs no activity", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: "c1" });
    prismaMock.messageLog.create.mockRejectedValue({ code: "P2002" });

    const result = await recordInboundFragment("s", emailFragment);

    expect(result).toEqual({ matched: 0, skipped: 0, duplicates: 1 });
    expect(prismaMock.activity.create).not.toHaveBeenCalled();
  });

  it("skips unknown senders (no contact match) without writing", async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);

    const result = await recordInboundFragment("s", emailFragment);

    expect(result).toEqual({ matched: 0, skipped: 1, duplicates: 0 });
    expect(prismaMock.messageLog.create).not.toHaveBeenCalled();
    expect(prismaMock.activity.create).not.toHaveBeenCalled();
  });
});
