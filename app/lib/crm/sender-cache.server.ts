/**
 * Short-lived cache of the Brevo sender preflight, keyed by shop + channel. SERVER ONLY.
 *
 * A 5,000-recipient batch runs as 5,000 separate jobs; without this, each one would re-read
 * ShopSettings and re-decrypt the API key. The TTL is deliberately short so a key rotation or a
 * Settings change takes effect without a restart, and `invalidate` makes the common case immediate.
 *
 * Lives in its own module (rather than inside the job handlers) so the Settings route can
 * invalidate it without importing the entire job/messaging/Shopify graph.
 */

import type { SenderPrep } from "./messaging.server";
import type { Channel } from "./constants";

const TTL_MS = 60_000;

const cache = new Map<string, { at: number; prep: SenderPrep }>();

function key(shop: string, channel: Channel): string {
  return `${shop}:${channel}`;
}

/** Cached preflight for this shop+channel, or null when absent/expired. */
export function getCachedPrep(shop: string, channel: Channel): SenderPrep | null {
  const hit = cache.get(key(shop, channel));
  if (!hit) return null;
  if (Date.now() - hit.at >= TTL_MS) {
    cache.delete(key(shop, channel));
    return null;
  }
  return hit.prep;
}

/**
 * Cache a preflight result.
 *
 * Only successful preflights are stored: caching a failure would pin a misconfiguration in place
 * for a minute after the merchant has already fixed it in Settings.
 */
export function setCachedPrep(shop: string, channel: Channel, prep: SenderPrep): void {
  if (!prep.ok) return;
  cache.set(key(shop, channel), { at: Date.now(), prep });
}

/** Drop cached credentials for a shop — call whenever sender or compliance settings change. */
export function invalidatePrepCache(shop: string): void {
  cache.delete(key(shop, "EMAIL"));
  cache.delete(key(shop, "SMS"));
}

/** Test helper. */
export function clearPrepCache(): void {
  cache.clear();
}
