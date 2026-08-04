import { describe, expect, it } from "vitest";
import {
  htmlFooter,
  mailtoUnsubscribe,
  textFooter,
  unsubscribeHeaders,
  unsubscribeTarget,
  withFooters,
  type FooterConfig,
} from "./compliance-footer";

const hosted: FooterConfig = {
  businessAddress: "Store Ltd\n1 Example St\nPhoenix, AZ 85001",
  unsubscribeUrl: "https://store.com/unsubscribe",
  senderEmail: "hello@store.com",
  senderName: "Store",
};

const mailtoOnly: FooterConfig = {
  businessAddress: "Store Ltd, 1 Example St",
  unsubscribeUrl: null,
  senderEmail: "hello@store.com",
  senderName: null,
};

describe("unsubscribeTarget", () => {
  it("prefers the merchant's hosted page", () => {
    expect(unsubscribeTarget(hosted)).toBe("https://store.com/unsubscribe");
  });

  it("falls back to a mailto: opt-out", () => {
    expect(unsubscribeTarget(mailtoOnly)).toBe(mailtoUnsubscribe("hello@store.com"));
  });

  it("treats a blank URL as unset", () => {
    expect(unsubscribeTarget({ ...hosted, unsubscribeUrl: "   " })).toContain("mailto:");
  });
});

describe("unsubscribeHeaders", () => {
  it("advertises one-click POST for an https target", () => {
    const headers = unsubscribeHeaders(hosted);
    expect(headers["List-Unsubscribe"]).toBe("<https://store.com/unsubscribe>");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("omits one-click POST for a mailto: target", () => {
    // RFC 8058 one-click is undefined for mailto:; advertising it would make compliant providers
    // POST to a mailto URI, which silently does nothing.
    const headers = unsubscribeHeaders(mailtoOnly);
    expect(headers["List-Unsubscribe"]).toContain("mailto:");
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
  });
});

describe("footers", () => {
  it("includes the postal address and opt-out in the text part", () => {
    const footer = textFooter(hosted);
    expect(footer).toContain("Phoenix, AZ 85001");
    expect(footer).toContain("https://store.com/unsubscribe");
    expect(footer).toContain("Store");
  });

  it("includes a clickable opt-out and the address in the HTML part", () => {
    const footer = htmlFooter(hosted);
    expect(footer).toContain('href="https://store.com/unsubscribe"');
    expect(footer).toContain("Phoenix, AZ 85001");
    // Merchant-entered newlines survive as line breaks.
    expect(footer).toContain("<br />");
  });

  it("escapes HTML in merchant-supplied values", () => {
    const footer = htmlFooter({
      ...hosted,
      businessAddress: "<script>alert(1)</script>",
      senderName: "A & B <b>",
    });
    expect(footer).not.toContain("<script>");
    expect(footer).toContain("&lt;script&gt;");
    expect(footer).toContain("A &amp; B");
  });

  it("appends to both parts without discarding the body", () => {
    const out = withFooters(hosted, { html: "<p>Hi</p>", text: "Hi" });
    expect(out.html.startsWith("<p>Hi</p>")).toBe(true);
    expect(out.text.startsWith("Hi")).toBe(true);
    expect(out.text).toContain("Unsubscribe:");
  });
});
