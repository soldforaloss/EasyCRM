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
import { logger, reportError } from "../lib/logger.server";
import { rateLimit } from "../lib/rate-limit.server";

const MAX_BODY_BYTES = 256 * 1024;

// Two-stage throttling. The per-IP bucket is checked BEFORE the database lookup, so an
// unauthenticated flood of bogus tokens cannot turn into a flood of queries. The per-shop bucket
// then bounds how much work one legitimate (or compromised) webhook URL can cause.
// See DECISIONS.md §12.
const IP_LIMIT = { capacity: 120, refillPerSecond: 2 };
const SHOP_LIMIT = { capacity: 300, refillPerSecond: 5 };

/** Best-effort client IP from the proxy headers; falls back to a shared bucket. */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: { "Retry-After": String(retryAfterSeconds) },
  });
}

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

  // Throttle by source address before touching the database.
  const ipCheck = rateLimit(`inbound:ip:${clientIp(request)}`, IP_LIMIT);
  if (!ipCheck.allowed) {
    logger.warn("inbound.rate_limited", { scope: "ip", ip: clientIp(request) });
    return tooManyRequests(ipCheck.retryAfterSeconds);
  }

  // Resolve the shop from the URL token. Unknown/empty → 404 (don't confirm the URL scheme).
  const resolved = await findShopByInboundToken(params.token ?? "");
  if (!resolved) {
    return new Response("Not found", { status: 404 });
  }

  const shopCheck = rateLimit(`inbound:shop:${resolved.shop}`, SHOP_LIMIT);
  if (!shopCheck.allowed) {
    logger.warn("inbound.rate_limited", { scope: "shop", shop: resolved.shop });
    return tooManyRequests(shopCheck.retryAfterSeconds);
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
    logger.warn("inbound.oversized_body", { shop: resolved.shop, bytes: raw.length });
    return new Response(null, { status: 200 });
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    logger.warn("inbound.invalid_json", { shop: resolved.shop });
    return new Response(null, { status: 200 });
  }

  // Always 200 for authenticated requests (even on a per-message failure) so Brevo doesn't retry-storm.
  try {
    const result = await recordInboundFragment(resolved.shop, body);
    logger.info("inbound.processed", {
      shop: resolved.shop,
      matched: result.matched,
      skipped: result.skipped,
      duplicates: result.duplicates,
    });
  } catch (error) {
    void reportError("inbound.processing_error", error, { shop: resolved.shop });
  }
  return new Response(null, { status: 200 });
};
