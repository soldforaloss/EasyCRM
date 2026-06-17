import { describe, expect, it, vi } from "vitest";
import {
  sendBrevoEmail,
  sendBrevoSms,
  toBrevoSmsRecipient,
  validateBrevoKey,
} from "./client.server";

type MockRes = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

function res(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): MockRes {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** A fetch mock that returns queued responses (or throws when an Error is queued). */
function queue(responses: Array<MockRes | Error>) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string, init?: unknown) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  });
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("validateBrevoKey", () => {
  it("returns ok with account data and sends the api-key header", async () => {
    const { fetchImpl, calls } = queue([
      res(200, { email: "merchant@shop.com", firstName: "Mer" }),
    ]);
    const result = await validateBrevoKey("KEY123", { fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.email).toBe("merchant@shop.com");
    const init = calls[0].init as { headers: Record<string, string> };
    expect(init.headers["api-key"]).toBe("KEY123");
    expect(calls[0].url).toContain("/account");
  });

  it("fails fast on 401 (invalid key) without retrying", async () => {
    const { fetchImpl, calls } = queue([
      res(401, { code: "unauthorized", message: "Key not found" }),
    ]);
    const result = await validateBrevoKey("BAD", { fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.retriable).toBe(false);
      expect(result.error).toMatch(/Key not found/);
    }
    expect(calls).toHaveLength(1);
  });

  it("returns an error when no key is provided", async () => {
    const result = await validateBrevoKey("", { sleep: noSleep });
    expect(result.ok).toBe(false);
  });
});

describe("sendBrevoEmail", () => {
  it("succeeds on 201 with messageId", async () => {
    const { fetchImpl, calls } = queue([res(201, { messageId: "<abc@brevo>" })]);
    const result = await sendBrevoEmail(
      "KEY",
      {
        sender: { email: "shop@x.com", name: "Shop" },
        to: [{ email: "a@b.com" }],
        subject: "Hi",
        htmlContent: "<p>Hi</p>",
      },
      { fetchImpl, sleep: noSleep },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.messageId).toBe("<abc@brevo>");
    expect(calls[0].url).toContain("/smtp/email");
  });

  it("retries on 429 then succeeds", async () => {
    const { fetchImpl, calls } = queue([
      res(429, { message: "rate limited" }, { "retry-after": "0" }),
      res(201, { messageId: "ok" }),
    ]);
    const result = await sendBrevoEmail(
      "KEY",
      { sender: { email: "s@x.com" }, to: [{ email: "a@b.com" }] },
      { fetchImpl, sleep: noSleep },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after retries on persistent 500 and flags retriable", async () => {
    const { fetchImpl, calls } = queue([res(503, { message: "down" })]);
    const result = await sendBrevoEmail(
      "KEY",
      { sender: { email: "s@x.com" }, to: [{ email: "a@b.com" }] },
      { fetchImpl, sleep: noSleep, retries: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retriable).toBe(true);
    expect(calls).toHaveLength(3); // 1 + 2 retries
  });

  it("retries a network error then succeeds", async () => {
    const { fetchImpl, calls } = queue([
      new Error("ECONNRESET"),
      res(201, { messageId: "ok" }),
    ]);
    const result = await sendBrevoEmail(
      "KEY",
      { sender: { email: "s@x.com" }, to: [{ email: "a@b.com" }] },
      { fetchImpl, sleep: noSleep },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("sendBrevoSms", () => {
  it("posts to the SMS endpoint", async () => {
    const { fetchImpl, calls } = queue([res(201, { messageId: 123 })]);
    const result = await sendBrevoSms(
      "KEY",
      { sender: "MyShop", recipient: "15551234567", content: "Hi", type: "transactional" },
      { fetchImpl, sleep: noSleep },
    );
    expect(result.ok).toBe(true);
    expect(calls[0].url).toContain("/transactionalSMS/send");
  });
});

describe("toBrevoSmsRecipient", () => {
  it("strips the leading +", () => {
    expect(toBrevoSmsRecipient("+15551234567")).toBe("15551234567");
    expect(toBrevoSmsRecipient("15551234567")).toBe("15551234567");
  });
});
