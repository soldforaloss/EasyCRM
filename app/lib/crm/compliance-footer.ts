/**
 * Marketing-email compliance furniture: the postal-address + opt-out footer and the
 * `List-Unsubscribe` headers. See DECISIONS.md §10.
 *
 * CAN-SPAM (US) requires every marketing email to carry a valid physical postal address and a
 * working opt-out mechanism. Gmail/Yahoo bulk-sender rules additionally require one-click
 * unsubscribe via `List-Unsubscribe` + `List-Unsubscribe-Post`. Brevo does not add either of
 * these to *transactional* (`/v3/smtp/email`) sends, which is the endpoint this app uses — so
 * the app must supply them itself.
 *
 * Pure module (no DB, no env) so it is directly unit-testable and safe to import anywhere.
 */

export interface FooterConfig {
  /** Merchant's physical postal address. Required — marketing email is blocked without it. */
  businessAddress: string;
  /** Merchant-hosted opt-out page. Falls back to a mailto: opt-out when absent. */
  unsubscribeUrl?: string | null;
  /** The configured sender address, used to build the mailto: fallback. */
  senderEmail: string;
  /** Shown as the "from" identity in the footer; defaults to the sender email. */
  senderName?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The mailto: URI used when the merchant has not supplied a hosted unsubscribe page. */
export function mailtoUnsubscribe(senderEmail: string): string {
  return `mailto:${senderEmail}?subject=Unsubscribe`;
}

/** Resolve the opt-out target: the merchant's hosted page when set, otherwise a mailto:. */
export function unsubscribeTarget(config: FooterConfig): string {
  const url = config.unsubscribeUrl?.trim();
  return url ? url : mailtoUnsubscribe(config.senderEmail);
}

/**
 * `List-Unsubscribe` (RFC 2369) and `List-Unsubscribe-Post` (RFC 8058) headers.
 *
 * One-click POST is only advertised for an https: target — RFC 8058 one-click is undefined for
 * mailto:, and advertising it there would make compliant mailbox providers issue a POST to a
 * mailto URI, which silently does nothing.
 */
export function unsubscribeHeaders(config: FooterConfig): Record<string, string> {
  const target = unsubscribeTarget(config);
  const isHttp = /^https?:\/\//i.test(target);
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${target}>`,
  };
  if (isHttp) {
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return headers;
}

/** Plain-text footer appended to the text part of every marketing email. */
export function textFooter(config: FooterConfig): string {
  const from = config.senderName?.trim() || config.senderEmail;
  return [
    "",
    "—",
    `You are receiving this because you opted in to marketing from ${from}.`,
    `Unsubscribe: ${unsubscribeTarget(config)}`,
    config.businessAddress.trim(),
  ].join("\n");
}

/** HTML footer appended to the HTML part of every marketing email. */
export function htmlFooter(config: FooterConfig): string {
  const from = escapeHtml(config.senderName?.trim() || config.senderEmail);
  const target = unsubscribeTarget(config);
  // Preserve merchant-entered line breaks in the postal address.
  const address = escapeHtml(config.businessAddress.trim()).replace(/\n/g, "<br />");
  return [
    '<hr style="margin:24px 0;border:none;border-top:1px solid #ddd" />',
    '<div style="font-size:12px;color:#666;line-height:1.5">',
    `<p>You are receiving this because you opted in to marketing from ${from}.</p>`,
    `<p><a href="${escapeHtml(target)}">Unsubscribe</a></p>`,
    `<p>${address}</p>`,
    "</div>",
  ].join("");
}

/** Append both footers to a rendered body. */
export function withFooters(
  config: FooterConfig,
  body: { html: string; text: string },
): { html: string; text: string } {
  return {
    html: body.html + htmlFooter(config),
    text: body.text + textFooter(config),
  };
}
