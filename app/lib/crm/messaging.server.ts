/**
 * Messaging orchestration: enforce marketing consent, render merge vars per recipient, send via
 * Brevo, write a MessageLog for every attempt, and append an EMAIL_SENT / SMS_SENT activity.
 * SERVER ONLY.
 *
 * CONSENT IS ENFORCED HERE AND ONLY HERE (see DECISIONS.md §10). Every path that can put a
 * message on the wire funnels through `sendOneToContact`, which refuses to send to a contact
 * whose mirrored Shopify marketing state is not `SUBSCRIBED`. Callers cannot opt out of the
 * check — there is no bypass parameter, deliberately.
 *
 * Single send (detail page) and bulk send (one Job per recipient, see jobs/) both call
 * `sendOneToContact`, so the gate, the logging and the idempotency behave identically.
 */

import type { Contact } from "@prisma/client";
import prisma from "../../db.server";
import { sendBrevoEmail, sendBrevoSms, toBrevoSmsRecipient } from "../brevo/client.server";
import type { BrevoEmailRequest } from "../brevo/types";
import { plainToHtml, renderMerge } from "../merge";
import { normalizeE164 } from "../phone";
import { displayName, formatDate, formatMoney, parseMoney } from "../format";
import { logActivity, parseActivityPayload } from "./activity.server";
import { getDecryptedBrevoKey, getOrCreateSettings } from "./settings.server";
import { canReceive, consentStateFor } from "./constants";
import type { Channel, MessageStatus, SkipReason } from "./constants";
import {
  unsubscribeHeaders,
  withFooters,
  type FooterConfig,
} from "./compliance-footer";
import type { MergeVars } from "./types";

/* ------------------------------------------------------------------ */
/* Merge variable context                                              */
/* ------------------------------------------------------------------ */

type MergeContact = Pick<
  Contact,
  | "id"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "ordersCount"
  | "amountSpent"
  | "currencyCode"
  | "lastOrderAt"
>;

/** Build per-recipient merge vars for a set of contacts (one query for last-order totals). */
export async function buildMergeVarsMap(
  shop: string,
  contacts: MergeContact[],
): Promise<Map<string, MergeVars>> {
  const ids = contacts.map((c) => c.id);
  const lastOrderByContact = new Map<string, { total?: string; currency?: string }>();
  if (ids.length > 0) {
    // Fetch only the LATEST order per contact (not the whole batch's order history). `distinct`
    // + leading `contactId` orderBy gives one deterministic row per contact (DISTINCT ON on
    // Postgres). The secondary keys make the tiebreak deterministic for equal timestamps.
    const acts = await prisma.activity.findMany({
      where: { shop, type: "ORDER_PLACED", contactId: { in: ids } },
      orderBy: [{ contactId: "asc" }, { occurredAt: "desc" }, { createdAt: "desc" }],
      distinct: ["contactId"],
      select: { contactId: true, payload: true },
    });
    for (const a of acts) {
      const p = parseActivityPayload<{ total?: string; currency?: string }>(a);
      lastOrderByContact.set(a.contactId, { total: p?.total, currency: p?.currency });
    }
  }

  const map = new Map<string, MergeVars>();
  for (const c of contacts) {
    const lo = lastOrderByContact.get(c.id);
    map.set(c.id, {
      firstName: c.firstName ?? "",
      lastName: c.lastName ?? "",
      fullName: displayName(c.firstName, c.lastName, ""),
      email: c.email ?? "",
      phone: c.phone ?? "",
      ordersCount: c.ordersCount,
      totalSpent: formatMoney(c.amountSpent, c.currencyCode),
      lastOrderTotal: lo?.total
        ? formatMoney(parseMoney(lo.total), lo.currency ?? c.currencyCode)
        : "",
      lastOrderDate: c.lastOrderAt ? formatDate(c.lastOrderAt) : "",
    });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/** All message attempts for one contact, oldest-first (chronological thread order). */
export async function listMessageLogs(shop: string, contactId: string, limit = 200) {
  const logs = await prisma.messageLog.findMany({
    where: { shop, contactId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return logs.reverse();
}

/* ------------------------------------------------------------------ */
/* Sender preflight                                                    */
/* ------------------------------------------------------------------ */

export interface SenderPrep {
  ok: boolean;
  error?: string;
  apiKey?: string;
  senderEmail?: string;
  senderName?: string;
  smsSender?: string;
  /** Present for EMAIL only — postal address + opt-out target for the required footer. */
  footer?: FooterConfig;
}

/**
 * Resolve everything needed to send on `channel`, or an actionable error.
 *
 * For EMAIL this also enforces that the merchant has configured a physical postal address:
 * CAN-SPAM makes it mandatory in marketing mail, so sending without one is not an option we
 * offer. The error text points at the exact Settings field to fill in.
 */
export async function prepareSend(shop: string, channel: Channel): Promise<SenderPrep> {
  const settings = await getOrCreateSettings(shop);
  if (!settings.brevoApiKeyEncrypted || !settings.brevoConnected) {
    return { ok: false, error: "Connect Brevo in Settings before sending." };
  }
  let apiKey: string | null = null;
  try {
    apiKey = await getDecryptedBrevoKey(shop);
  } catch {
    return {
      ok: false,
      error: "The stored Brevo key could not be decrypted. Re-enter it in Settings.",
    };
  }
  if (!apiKey) return { ok: false, error: "No Brevo API key configured." };

  if (channel === "EMAIL") {
    if (!settings.brevoSenderEmail) {
      return { ok: false, error: "Set a verified sender email in Settings before sending email." };
    }
    if (!settings.businessAddress?.trim()) {
      return {
        ok: false,
        error:
          "Add your business postal address in Settings before sending email. " +
          "Anti-spam law (CAN-SPAM) requires it in every marketing message.",
      };
    }
    return {
      ok: true,
      apiKey,
      senderEmail: settings.brevoSenderEmail,
      senderName: settings.brevoSenderName ?? undefined,
      footer: {
        businessAddress: settings.businessAddress,
        unsubscribeUrl: settings.unsubscribeUrl,
        senderEmail: settings.brevoSenderEmail,
        senderName: settings.brevoSenderName,
      },
    };
  }
  if (!settings.brevoSmsSender) {
    return { ok: false, error: "Set an SMS sender in Settings before sending SMS." };
  }
  return { ok: true, apiKey, smsSender: settings.brevoSmsSender };
}

/* ------------------------------------------------------------------ */
/* Recipient eligibility                                               */
/* ------------------------------------------------------------------ */

interface RecipientContact {
  email?: string | null;
  phone?: string | null;
  emailMarketingState?: string | null;
  smsMarketingState?: string | null;
}

export interface Ineligible {
  reason: SkipReason;
  detail: string;
}

/**
 * Decide whether a contact may be messaged on `channel`, without sending anything.
 *
 * Consent is checked FIRST and independently of whether an address exists, so a non-consented
 * contact is always recorded as NO_CONSENT rather than being masked by a missing-address skip.
 * Returns null when the contact is eligible.
 */
export function checkEligibility(
  channel: Channel,
  contact: RecipientContact,
): Ineligible | null {
  if (!canReceive(channel, contact)) {
    const state = consentStateFor(channel, contact);
    return {
      reason: "NO_CONSENT",
      detail: `Not subscribed to ${channel === "EMAIL" ? "email" : "SMS"} marketing (Shopify state: ${state ?? "unknown"}).`,
    };
  }
  if (channel === "EMAIL") {
    if (!contact.email) {
      return { reason: "NO_ADDRESS", detail: "Contact has no email address." };
    }
    return null;
  }
  const phone = normalizeE164(contact.phone);
  if (!phone.ok) {
    return { reason: "INVALID_PHONE", detail: phone.reason };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

interface ClaimInput {
  shop: string;
  contactId: string;
  channel: Channel;
  subject: string | null;
  bodySnapshot: string;
  templateId?: string | null;
  sentByStaffId?: string | null;
  batchId?: string | null;
}

/**
 * Reserve the right to send to this contact by writing a QUEUED MessageLog row.
 *
 * When `batchId` is set, the unique (batchId, contactId) index turns this into the bulk-send
 * idempotency guard: a retried job hits P2002 and gets `null` back, so a recipient can never be
 * messaged twice by the same batch — even if the worker crashed mid-send and the job re-ran.
 * Returns the log id, or null when this recipient was already claimed.
 */
async function claimLog(input: ClaimInput): Promise<string | null> {
  try {
    const log = await prisma.messageLog.create({
      data: {
        shop: input.shop,
        contactId: input.contactId,
        channel: input.channel,
        subject: input.subject,
        bodySnapshot: input.bodySnapshot,
        status: "QUEUED",
        templateId: input.templateId ?? null,
        sentByStaffId: input.sentByStaffId ?? null,
        batchId: input.batchId ?? null,
      },
      select: { id: true },
    });
    return log.id;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return null; // already claimed
    throw error;
  }
}

interface FinalizeInput {
  logId: string;
  shop: string;
  contactId: string;
  channel: Channel;
  subject: string | null;
  bodySnapshot: string;
  status: MessageStatus;
  skipReason?: SkipReason | null;
  providerMessageId?: string | null;
  error?: string | null;
}

/** Move a claimed log row to its terminal state, and record the timeline activity on success. */
async function finalizeLog(input: FinalizeInput): Promise<void> {
  await prisma.messageLog.update({
    where: { id: input.logId },
    data: {
      status: input.status,
      skipReason: input.skipReason ?? null,
      providerMessageId: input.providerMessageId ?? null,
      error: input.error ?? null,
    },
  });
  if (input.status === "SENT") {
    await logActivity({
      shop: input.shop,
      contactId: input.contactId,
      type: input.channel === "EMAIL" ? "EMAIL_SENT" : "SMS_SENT",
      payload: {
        messageLogId: input.logId,
        subject: input.subject,
        preview: input.bodySnapshot.slice(0, 120),
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Test send (Settings page) — no contact / no MessageLog              */
/* ------------------------------------------------------------------ */

/**
 * Send a test message to an address the merchant just typed in Settings.
 *
 * No consent check: the merchant is messaging themselves to verify their own configuration,
 * the content is fixed boilerplate, and there is no Contact involved. The compliance footer is
 * still applied so the merchant sees exactly what recipients will see.
 */
export async function sendTestMessage(
  shop: string,
  channel: Channel,
  recipient: string,
): Promise<{ ok: boolean; error?: string }> {
  const prep = await prepareSend(shop, channel);
  if (!prep.ok) return { ok: false, error: prep.error };

  if (channel === "EMAIL") {
    const to = recipient.trim();
    if (!to) return { ok: false, error: "Enter a test email address." };
    const parts = withFooters(prep.footer!, {
      html: "<p>This is a test email from Easy CRM via Brevo. If you received it, your sending setup works. 🎉</p>",
      text: "This is a test email from Easy CRM via Brevo. If you received it, your sending setup works.",
    });
    const res = await sendBrevoEmail(prep.apiKey!, {
      sender: { email: prep.senderEmail!, name: prep.senderName },
      to: [{ email: to }],
      subject: "Easy CRM test email",
      htmlContent: parts.html,
      textContent: parts.text,
      headers: unsubscribeHeaders(prep.footer!),
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  const phone = normalizeE164(recipient);
  if (!phone.ok) return { ok: false, error: phone.reason };
  const res = await sendBrevoSms(prep.apiKey!, {
    sender: prep.smsSender!,
    recipient: toBrevoSmsRecipient(phone.e164),
    content: "Easy CRM test SMS — your Brevo setup works.",
    type: "transactional",
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/* ------------------------------------------------------------------ */
/* Single send — the one and only path to the wire                     */
/* ------------------------------------------------------------------ */

export interface SendParams {
  contactId: string;
  channel: Channel;
  subject?: string;
  body: string;
  templateId?: string | null;
  sentByStaffId?: string | null;
  /** Set by the bulk worker; enables per-(batch,contact) idempotency. */
  batchId?: string | null;
}

export interface SendOutcome {
  ok: boolean;
  status: MessageStatus | "BLOCKED" | "DUPLICATE";
  error?: string;
  skipReason?: SkipReason;
  messageLogId?: string;
}

/**
 * Send one message to one contact.
 *
 * Order of operations is deliberate:
 *   1. resolve the contact (shop-scoped),
 *   2. CONSENT + address eligibility — before any credential work or network call,
 *   3. sender preflight,
 *   4. claim a log row (idempotency),
 *   5. send, then finalize the row.
 *
 * `prep` may be passed in by the bulk worker to avoid re-decrypting the API key per recipient.
 */
export async function sendOneToContact(
  shop: string,
  params: SendParams,
  prep?: SenderPrep,
): Promise<SendOutcome> {
  const contact = await prisma.contact.findFirst({
    where: { id: params.contactId, shop },
  });
  if (!contact) return { ok: false, status: "BLOCKED", error: "Contact not found." };

  const vars = (await buildMergeVarsMap(shop, [contact])).get(contact.id)!;
  const body = renderMerge(params.body, vars).text;
  const subject =
    params.channel === "EMAIL"
      ? renderMerge(params.subject ?? "", vars).text || "(no subject)"
      : null;

  // --- The consent gate. Nothing below this line runs for a non-consented contact. ---
  const ineligible = checkEligibility(params.channel, contact);
  if (ineligible) {
    const logId = await claimLog({
      shop,
      contactId: contact.id,
      channel: params.channel,
      subject,
      bodySnapshot: body,
      templateId: params.templateId,
      sentByStaffId: params.sentByStaffId,
      batchId: params.batchId,
    });
    if (!logId) return { ok: false, status: "DUPLICATE" };
    await finalizeLog({
      logId,
      shop,
      contactId: contact.id,
      channel: params.channel,
      subject,
      bodySnapshot: body,
      status: "SKIPPED",
      skipReason: ineligible.reason,
      error: ineligible.detail,
    });
    return {
      ok: false,
      status: "SKIPPED",
      skipReason: ineligible.reason,
      error: ineligible.detail,
      messageLogId: logId,
    };
  }

  const sender = prep ?? (await prepareSend(shop, params.channel));
  if (!sender.ok) return { ok: false, status: "BLOCKED", error: sender.error };

  const logId = await claimLog({
    shop,
    contactId: contact.id,
    channel: params.channel,
    subject,
    bodySnapshot: body,
    templateId: params.templateId,
    sentByStaffId: params.sentByStaffId,
    batchId: params.batchId,
  });
  if (!logId) return { ok: false, status: "DUPLICATE" };

  if (params.channel === "EMAIL") {
    const parts = withFooters(sender.footer!, {
      html: plainToHtml(body),
      text: body,
    });
    const req: BrevoEmailRequest = {
      sender: { email: sender.senderEmail!, name: sender.senderName },
      to: [
        {
          email: contact.email!,
          name: displayName(contact.firstName, contact.lastName, "") || undefined,
        },
      ],
      subject: subject!,
      htmlContent: parts.html,
      textContent: parts.text,
      headers: unsubscribeHeaders(sender.footer!),
    };
    const res = await sendBrevoEmail(sender.apiKey!, req);
    await finalizeLog({
      logId,
      shop,
      contactId: contact.id,
      channel: "EMAIL",
      subject,
      bodySnapshot: body,
      status: res.ok ? "SENT" : "FAILED",
      providerMessageId: res.ok ? res.data.messageId ?? null : null,
      error: res.ok ? null : res.error,
    });
    return res.ok
      ? { ok: true, status: "SENT", messageLogId: logId }
      : { ok: false, status: "FAILED", error: res.error, messageLogId: logId };
  }

  // SMS — eligibility already proved the phone normalizes.
  const phone = normalizeE164(contact.phone);
  const res = await sendBrevoSms(sender.apiKey!, {
    sender: sender.smsSender!,
    recipient: toBrevoSmsRecipient(phone.ok ? phone.e164 : ""),
    content: body,
    type: "marketing",
  });
  await finalizeLog({
    logId,
    shop,
    contactId: contact.id,
    channel: "SMS",
    subject: null,
    bodySnapshot: body,
    status: res.ok ? "SENT" : "FAILED",
    providerMessageId: res.ok ? (res.data.messageId != null ? String(res.data.messageId) : null) : null,
    error: res.ok ? null : res.error,
  });
  return res.ok
    ? { ok: true, status: "SENT", messageLogId: logId }
    : { ok: false, status: "FAILED", error: res.error, messageLogId: logId };
}

/** Backwards-compatible alias — the detail page's single-send entry point. */
export const sendToContact = sendOneToContact;
