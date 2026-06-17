/**
 * Inbound (two-way) messaging: ingest customer replies from Brevo Conversations webhooks and store
 * them as INBOUND MessageLog rows + a timeline activity. SERVER ONLY.
 *
 * Brevo delivers `conversationStarted` / `conversationFragment` / `conversationTranscript` events,
 * each carrying a `messages[]` array and a `visitor` object. Customer replies have `type:"visitor"`;
 * our own outbound (sent via messaging.server) shows as `type:"agent"` and is ignored — so there is
 * no duplicate-of-outbound problem. Idempotency mirrors the ProcessedOrder pattern: a unique
 * (shop, providerEventId) index + a P2002 no-op on redelivery (see mirror.server.ts).
 */

import { createHash } from "crypto";
import prisma from "../../db.server";
import { logActivity } from "./activity.server";
import { findContactByEmail, findContactByPhone } from "./contacts.server";
import { normalizeE164 } from "../phone";

export type InboundChannel = "EMAIL" | "SMS";

export interface ParsedInboundMessage {
  /** Stable Brevo message id (or a deterministic hash fallback) — the dedup key. */
  providerEventId: string;
  channel: InboundChannel;
  text: string;
  senderEmail: string | null;
  senderPhone: string | null;
  conversationId: string | null;
  /** From the message's epoch-ms timestamp; null when absent (recorder defaults to now). */
  createdAt: Date | null;
}

export interface RecordInboundResult {
  matched: number;
  skipped: number;
  duplicates: number;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONEISH_RE = /^\+?[0-9][0-9\s().-]{6,}$/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackId(conversationId: string | null, createdAtMs: number | null, text: string): string {
  const hash = createHash("sha256")
    .update(`${conversationId ?? ""}|${createdAtMs ?? ""}|${text}`)
    .digest("hex")
    .slice(0, 32);
  return `h_${hash}`;
}

/**
 * Map Brevo `visitor.source` to a channel we thread (EMAIL/SMS). The exact source strings for
 * email/SMS are unconfirmed, so this is permissive; callers may fall back to inferring from the
 * sender. Returns null for chat/social/unknown sources (those are not threaded).
 */
export function deriveChannel(source: unknown): InboundChannel | null {
  const s = typeof source === "string" ? source.toLowerCase() : "";
  if (!s) return null;
  if (s.includes("mail")) return "EMAIL";
  if (s.includes("sms") || s.includes("text")) return "SMS";
  return null;
}

/** Pull a sender email + phone out of the visitor object (top-level fields and `attributes`). */
export function extractSender(visitor: unknown): { email: string | null; phone: string | null } {
  const v = asRecord(visitor);
  if (!v) return { email: null, phone: null };

  const candidates: string[] = [];
  for (const key of ["email", "phone", "displayedName", "id"]) {
    const val = asString(v[key]);
    if (val) candidates.push(val);
  }
  const attrs = asRecord(v.attributes);
  if (attrs) {
    for (const val of Object.values(attrs)) {
      const s = asString(val);
      if (s) candidates.push(s);
    }
  }

  let email: string | null = null;
  let phone: string | null = null;
  for (const c of candidates) {
    const t = c.trim();
    if (!email && EMAIL_RE.test(t)) email = t;
    else if (!phone && PHONEISH_RE.test(t)) phone = t;
  }
  return { email, phone };
}

/**
 * Parse a Conversations webhook body into inbound (customer) messages. Pure — no DB, no logging.
 * Keeps only `type:"visitor"` messages and resolves a single channel for the fragment (from
 * `visitor.source`, falling back to the sender shape). Returns [] for unknown channels or malformed
 * input (never throws).
 */
export function parseConversationFragment(body: unknown): ParsedInboundMessage[] {
  const root = asRecord(body);
  if (!root) return [];

  const visitor = root.visitor;
  const sender = extractSender(visitor);
  const channel =
    deriveChannel(asRecord(visitor)?.source) ?? inferChannelFromSender(sender);
  if (!channel) return [];

  const conversationId = asString(root.conversationId);
  const messages = Array.isArray(root.messages) ? root.messages : [];

  const out: ParsedInboundMessage[] = [];
  for (const m of messages) {
    const msg = asRecord(m);
    if (!msg || msg.type !== "visitor") continue; // inbound only; ignore agent (our outbound)

    const html = asString(msg.html);
    const text = asString(msg.text) ?? (html ? stripHtml(html) : "");
    const createdAtMs = typeof msg.createdAt === "number" ? msg.createdAt : null;
    const providerEventId = asString(msg.id) ?? fallbackId(conversationId, createdAtMs, text);

    out.push({
      providerEventId,
      channel,
      text,
      senderEmail: sender.email,
      senderPhone: sender.phone,
      conversationId,
      createdAt: createdAtMs != null ? new Date(createdAtMs) : null,
    });
  }
  return out;
}

function inferChannelFromSender(sender: { email: string | null; phone: string | null }): InboundChannel | null {
  if (sender.email && !sender.phone) return "EMAIL";
  if (sender.phone && !sender.email) return "SMS";
  return null;
}

function maskSender(msg: ParsedInboundMessage): string {
  const v = msg.senderEmail ?? msg.senderPhone ?? "unknown";
  if (v.length <= 4) return "***";
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

async function matchContact(shop: string, msg: ParsedInboundMessage) {
  if (msg.channel === "EMAIL" && msg.senderEmail) {
    return findContactByEmail(shop, msg.senderEmail);
  }
  if (msg.channel === "SMS" && msg.senderPhone) {
    const norm = normalizeE164(msg.senderPhone);
    if (norm.ok) {
      const byE164 = await findContactByPhone(shop, norm.e164);
      if (byE164) return byE164;
    }
    // Best-effort fallback: stored phone may not be in E.164 form.
    return findContactByPhone(shop, msg.senderPhone);
  }
  return null;
}

/**
 * Ingest a Conversations webhook body for one shop. Matches each customer message to a contact and
 * writes an idempotent INBOUND MessageLog (+ EMAIL_RECEIVED/SMS_RECEIVED activity). Unknown senders
 * are skipped (MessageLog.contactId is required) and logged. Never trusts any shop id from the body.
 */
export async function recordInboundFragment(shop: string, body: unknown): Promise<RecordInboundResult> {
  const parsed = parseConversationFragment(body);
  const result: RecordInboundResult = { matched: 0, skipped: 0, duplicates: 0 };

  for (const msg of parsed) {
    const contact = await matchContact(shop, msg);
    if (!contact) {
      result.skipped += 1;
      console.warn(
        `[inbound] no contact match shop=${shop} channel=${msg.channel} sender=${maskSender(msg)}`,
      );
      continue;
    }

    try {
      await prisma.messageLog.create({
        data: {
          shop,
          contactId: contact.id,
          channel: msg.channel,
          direction: "INBOUND",
          subject: null,
          bodySnapshot: msg.text,
          providerEventId: msg.providerEventId,
          ...(msg.createdAt ? { createdAt: msg.createdAt } : {}),
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        result.duplicates += 1; // redelivery of an already-stored message — no-op
        continue;
      }
      throw error;
    }

    await logActivity({
      shop,
      contactId: contact.id,
      type: msg.channel === "EMAIL" ? "EMAIL_RECEIVED" : "SMS_RECEIVED",
      occurredAt: msg.createdAt ?? undefined,
      payload: { channel: msg.channel, preview: msg.text.slice(0, 120) },
    });
    result.matched += 1;
  }

  return result;
}
