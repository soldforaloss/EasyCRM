/**
 * Public inbound webhook for Brevo Conversations (customer email/SMS replies). This route is
 * intentionally NOT Shopify-authenticated — auth is per-route in this app, so a route that opts
 * into neither `authenticate.admin` nor `authenticate.webhook` is naturally public. Security here
 * is a high-entropy per-shop token in the URL path (resolved to a shop) plus an optional shared
 * secret. Brevo Conversations webhooks can't be registered via the REST API, so the merchant adds
 * this URL manually (see the Settings "Receiving messages" section).
 */

import type { ActionFunctionArgs } from "react-router";
import { recordInboundFragment } from "../lib/crm/inbound.server";
import { findShopByInboundToken } from "../lib/crm/settings.server";
import { safeEqual } from "../lib/crypto.server";

const MAX_BODY_BYTES = 256 * 1024;

/** Pull the candidate secret from an Authorization header: `Bearer <secret>` or Basic (password). */
function extractAuthSecret(header: string | null): string | null {
  if (!header) return null;
  const space = header.indexOf(" ");
  if (space < 0) return null;
  const scheme = header.slice(0, space);
  const value = header.slice(space + 1).trim();
  if (!value) return null;
  if (/^bearer$/i.test(scheme)) return value;
  if (/^basic$/i.test(scheme)) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      return idx >= 0 ? decoded.slice(idx + 1) : decoded; // password part
    } catch {
      return null;
    }
  }
  return null;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Resolve the shop from the URL token. Unknown/empty → 404 (don't confirm the URL scheme).
  const resolved = await findShopByInboundToken(params.token ?? "");
  if (!resolved) {
    return new Response("Not found", { status: 404 });
  }

  // Optional shared secret (extra layer on top of the capability URL).
  if (resolved.secret) {
    const provided = extractAuthSecret(request.headers.get("authorization"));
    if (!provided || !safeEqual(provided, resolved.secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // Size guard on a public endpoint.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    console.warn(`[inbound] oversized body shop=${resolved.shop} bytes=${raw.length}`);
    return new Response(null, { status: 200 });
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    console.warn(`[inbound] invalid JSON shop=${resolved.shop}`);
    return new Response(null, { status: 200 });
  }

  // Always 200 for authenticated requests (even on a per-message failure) so Brevo doesn't retry-storm.
  try {
    const result = await recordInboundFragment(resolved.shop, body);
    console.log(
      `[inbound] shop=${resolved.shop} matched=${result.matched} skipped=${result.skipped} dup=${result.duplicates}`,
    );
  } catch (error) {
    console.error(`[inbound] processing error shop=${resolved.shop}`, error);
  }
  return new Response(null, { status: 200 });
};
