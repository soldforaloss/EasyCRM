/**
 * Staff attribution. SERVER ONLY. See DECISIONS.md §13.
 *
 * The CRM records who wrote a note, who owns a contact and who sent a message. This app uses
 * OFFLINE Shopify tokens, so `session.onlineAccessInfo` is not populated and cannot be the
 * source of that identity.
 *
 * The embedded session token (a JWT App Bridge sends with every request) does carry it: `sub` is
 * the Shopify staff user id. That is what we attribute to. It is per-request and verified by the
 * Shopify library before `authenticate.admin` resolves, so it cannot be spoofed by the client.
 *
 * `sessionToken` is absent for non-embedded contexts (and in some test paths), so every caller
 * must tolerate a null staff id — attribution is best-effort, never a hard requirement.
 */

import type { JwtPayload } from "@shopify/shopify-api";

/**
 * The Shopify staff user id for this request, or null when unavailable.
 *
 * `sub` is documented as the user id for session tokens issued to an embedded app.
 */
export function staffIdFromSessionToken(
  sessionToken: JwtPayload | undefined | null,
): string | null {
  const sub = (sessionToken as { sub?: unknown } | null | undefined)?.sub;
  if (typeof sub === "string" && sub.trim() !== "") return sub;
  if (typeof sub === "number") return String(sub);
  return null;
}
