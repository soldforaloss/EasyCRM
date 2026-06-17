/**
 * Messaging orchestration: render merge vars per recipient, send via Brevo, write a MessageLog
 * for every attempt, and append an EMAIL_SENT / SMS_SENT activity. SERVER ONLY.
 *
 * Single send (detail page) and bulk send (multi-select / segment) both route through here.
 * Bulk email uses Brevo's `messageVersions` batch (one API call per chunk); bulk SMS is
 * sequential (Brevo has no SMS batch endpoint) and relies on the client's retry/backoff.
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
import type { Channel, MessageStatus } from "./constants";
import type { MergeVars } from "./types";

const EMAIL_BATCH_SIZE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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

/**
 * All message attempts for one contact, oldest-first (chronological thread order). These are the
 * outbound messages sent from this shop — Brevo BYOK is send-only, so there is no inbound capture.
 */
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

interface SenderPrep {
  ok: boolean;
  error?: string;
  apiKey?: string;
  senderEmail?: string;
  senderName?: string;
  smsSender?: string;
}

async function prepareSend(shop: string, channel: Channel): Promise<SenderPrep> {
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
    return {
      ok: true,
      apiKey,
      senderEmail: settings.brevoSenderEmail,
      senderName: settings.brevoSenderName ?? undefined,
    };
  }
  if (!settings.brevoSmsSender) {
    return { ok: false, error: "Set an SMS sender in Settings before sending SMS." };
  }
  return { ok: true, apiKey, smsSender: settings.brevoSmsSender };
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

interface LogInput {
  shop: string;
  contactId: string;
  channel: Channel;
  subject: string | null;
  bodySnapshot: string;
  status: MessageStatus;
  providerMessageId?: string | null;
  error?: string | null;
  templateId?: string | null;
  sentByStaffId?: string | null;
}

async function writeLog(input: LogInput): Promise<string> {
  const log = await prisma.messageLog.create({
    data: {
      shop: input.shop,
      contactId: input.contactId,
      channel: input.channel,
      subject: input.subject,
      bodySnapshot: input.bodySnapshot,
      status: input.status,
      providerMessageId: input.providerMessageId ?? null,
      error: input.error ?? null,
      templateId: input.templateId ?? null,
      sentByStaffId: input.sentByStaffId ?? null,
    },
  });
  if (input.status === "SENT") {
    await logActivity({
      shop: input.shop,
      contactId: input.contactId,
      type: input.channel === "EMAIL" ? "EMAIL_SENT" : "SMS_SENT",
      payload: {
        messageLogId: log.id,
        subject: input.subject,
        preview: input.bodySnapshot.slice(0, 120),
      },
    });
  }
  return log.id;
}

/* ------------------------------------------------------------------ */
/* Test send (Settings page) — no contact / no MessageLog              */
/* ------------------------------------------------------------------ */

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
    const res = await sendBrevoEmail(prep.apiKey!, {
      sender: { email: prep.senderEmail!, name: prep.senderName },
      to: [{ email: to }],
      subject: "Easy CRM test email",
      htmlContent:
        "<p>This is a test email from Easy CRM via Brevo. If you received it, your sending setup works. 🎉</p>",
      textContent:
        "This is a test email from Easy CRM via Brevo. If you received it, your sending setup works.",
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
/* Single send                                                         */
/* ------------------------------------------------------------------ */

export interface SendParams {
  contactId: string;
  channel: Channel;
  subject?: string;
  body: string;
  templateId?: string | null;
  sentByStaffId?: string | null;
}

export interface SendOutcome {
  ok: boolean;
  status: MessageStatus | "BLOCKED";
  error?: string;
  messageLogId?: string;
}

export async function sendToContact(shop: string, params: SendParams): Promise<SendOutcome> {
  const contact = await prisma.contact.findFirst({
    where: { id: params.contactId, shop },
  });
  if (!contact) return { ok: false, status: "BLOCKED", error: "Contact not found." };

  const prep = await prepareSend(shop, params.channel);
  if (!prep.ok) return { ok: false, status: "BLOCKED", error: prep.error };

  const vars = (await buildMergeVarsMap(shop, [contact])).get(contact.id)!;
  const body = renderMerge(params.body, vars).text;

  if (params.channel === "EMAIL") {
    const subject = renderMerge(params.subject ?? "", vars).text || "(no subject)";
    if (!contact.email) {
      const id = await writeLog({
        shop,
        contactId: contact.id,
        channel: "EMAIL",
        subject,
        bodySnapshot: body,
        status: "FAILED",
        error: "Contact has no email address.",
        templateId: params.templateId,
        sentByStaffId: params.sentByStaffId,
      });
      return { ok: false, status: "FAILED", error: "Contact has no email address.", messageLogId: id };
    }
    const req: BrevoEmailRequest = {
      sender: { email: prep.senderEmail!, name: prep.senderName },
      to: [{ email: contact.email, name: displayName(contact.firstName, contact.lastName, "") || undefined }],
      subject,
      htmlContent: plainToHtml(body),
      textContent: body,
    };
    const res = await sendBrevoEmail(prep.apiKey!, req);
    const id = await writeLog({
      shop,
      contactId: contact.id,
      channel: "EMAIL",
      subject,
      bodySnapshot: body,
      status: res.ok ? "SENT" : "FAILED",
      providerMessageId: res.ok ? res.data.messageId ?? null : null,
      error: res.ok ? null : res.error,
      templateId: params.templateId,
      sentByStaffId: params.sentByStaffId,
    });
    return res.ok
      ? { ok: true, status: "SENT", messageLogId: id }
      : { ok: false, status: "FAILED", error: res.error, messageLogId: id };
  }

  // SMS
  const phone = normalizeE164(contact.phone);
  if (!phone.ok) {
    const id = await writeLog({
      shop,
      contactId: contact.id,
      channel: "SMS",
      subject: null,
      bodySnapshot: body,
      status: "FAILED",
      error: phone.reason,
      templateId: params.templateId,
      sentByStaffId: params.sentByStaffId,
    });
    return { ok: false, status: "FAILED", error: phone.reason, messageLogId: id };
  }
  const res = await sendBrevoSms(prep.apiKey!, {
    sender: prep.smsSender!,
    recipient: toBrevoSmsRecipient(phone.e164),
    content: body,
    type: "transactional",
  });
  const id = await writeLog({
    shop,
    contactId: contact.id,
    channel: "SMS",
    subject: null,
    bodySnapshot: body,
    status: res.ok ? "SENT" : "FAILED",
    providerMessageId: res.ok ? (res.data.messageId != null ? String(res.data.messageId) : null) : null,
    error: res.ok ? null : res.error,
    templateId: params.templateId,
    sentByStaffId: params.sentByStaffId,
  });
  return res.ok
    ? { ok: true, status: "SENT", messageLogId: id }
    : { ok: false, status: "FAILED", error: res.error, messageLogId: id };
}

/* ------------------------------------------------------------------ */
/* Bulk send                                                           */
/* ------------------------------------------------------------------ */

export interface BulkSendParams {
  contactIds: string[];
  channel: Channel;
  subject?: string;
  body: string;
  templateId?: string | null;
  sentByStaffId?: string | null;
}

export interface BulkSendResult {
  ok: boolean;
  error?: string;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
}

export async function sendBulk(shop: string, params: BulkSendParams): Promise<BulkSendResult> {
  const base: BulkSendResult = {
    ok: true,
    sent: 0,
    failed: 0,
    skipped: 0,
    total: params.contactIds.length,
  };

  const prep = await prepareSend(shop, params.channel);
  if (!prep.ok) return { ...base, ok: false, error: prep.error };

  const contacts = await prisma.contact.findMany({
    where: { shop, id: { in: params.contactIds } },
  });
  const varsMap = await buildMergeVarsMap(shop, contacts);

  if (params.channel === "EMAIL") {
    const withEmail = contacts.filter((c) => c.email);
    const withoutEmail = contacts.filter((c) => !c.email);

    // Skipped: no email address.
    for (const c of withoutEmail) {
      await writeLog({
        shop,
        contactId: c.id,
        channel: "EMAIL",
        subject: renderMerge(params.subject ?? "", varsMap.get(c.id)!).text || "(no subject)",
        bodySnapshot: renderMerge(params.body, varsMap.get(c.id)!).text,
        status: "FAILED",
        error: "Contact has no email address.",
        templateId: params.templateId,
        sentByStaffId: params.sentByStaffId,
      });
      base.skipped += 1;
    }

    for (const group of chunk(withEmail, EMAIL_BATCH_SIZE)) {
      const versions = group.map((c) => {
        const vars = varsMap.get(c.id)!;
        const subject = renderMerge(params.subject ?? "", vars).text || "(no subject)";
        const body = renderMerge(params.body, vars).text;
        return {
          contact: c,
          subject,
          body,
          to: [
            {
              email: c.email!,
              name: displayName(c.firstName, c.lastName, "") || undefined,
            },
          ],
        };
      });

      const req: BrevoEmailRequest = {
        sender: { email: prep.senderEmail!, name: prep.senderName },
        // Top-level fields are the batch default; each messageVersion overrides them, so the
        // first recipient here is just a placeholder default (not a duplicate send).
        to: versions[0].to,
        subject: versions[0]?.subject ?? "(no subject)",
        htmlContent: plainToHtml(versions[0]?.body ?? ""),
        messageVersions: versions.map((v) => ({
          to: v.to,
          subject: v.subject,
          htmlContent: plainToHtml(v.body),
          textContent: v.body,
        })),
      };

      const res = await sendBrevoEmail(prep.apiKey!, req);
      const messageIds = res.ok ? res.data.messageIds ?? [] : [];
      for (let i = 0; i < versions.length; i += 1) {
        const v = versions[i];
        await writeLog({
          shop,
          contactId: v.contact.id,
          channel: "EMAIL",
          subject: v.subject,
          bodySnapshot: v.body,
          status: res.ok ? "SENT" : "FAILED",
          providerMessageId: res.ok ? messageIds[i] ?? null : null,
          error: res.ok ? null : res.error,
          templateId: params.templateId,
          sentByStaffId: params.sentByStaffId,
        });
        if (res.ok) base.sent += 1;
        else base.failed += 1;
      }
    }
    return base;
  }

  // SMS — sequential (no batch endpoint).
  for (const c of contacts) {
    const vars = varsMap.get(c.id)!;
    const body = renderMerge(params.body, vars).text;
    const phone = normalizeE164(c.phone);
    if (!phone.ok) {
      await writeLog({
        shop,
        contactId: c.id,
        channel: "SMS",
        subject: null,
        bodySnapshot: body,
        status: "FAILED",
        error: phone.reason,
        templateId: params.templateId,
        sentByStaffId: params.sentByStaffId,
      });
      base.skipped += 1;
      continue;
    }
    const res = await sendBrevoSms(prep.apiKey!, {
      sender: prep.smsSender!,
      recipient: toBrevoSmsRecipient(phone.e164),
      content: body,
      type: "transactional",
    });
    await writeLog({
      shop,
      contactId: c.id,
      channel: "SMS",
      subject: null,
      bodySnapshot: body,
      status: res.ok ? "SENT" : "FAILED",
      providerMessageId: res.ok ? (res.data.messageId != null ? String(res.data.messageId) : null) : null,
      error: res.ok ? null : res.error,
      templateId: params.templateId,
      sentByStaffId: params.sentByStaffId,
    });
    if (res.ok) base.sent += 1;
    else base.failed += 1;
  }
  return base;
}
