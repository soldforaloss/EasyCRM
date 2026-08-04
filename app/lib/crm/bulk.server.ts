/**
 * Bulk send orchestration. SERVER ONLY. See DECISIONS.md §11.
 *
 * A bulk send is a MessageBatch row plus one SEND_ONE Job per recipient. The HTTP request only
 * writes those rows and returns — it never talks to Brevo. This is what keeps a 5,000-recipient
 * send from blowing the platform's request timeout, and it means a crashed instance resumes
 * instead of leaving a half-sent campaign with no record of where it stopped.
 *
 * Idempotency is layered:
 *   - Job.dedupeKey = `send:<batchId>:<contactId>` — enqueueing the same recipient twice no-ops.
 *   - MessageLog unique (batchId, contactId) — even if a job somehow runs twice, the second
 *     claim fails and no second message goes out.
 */

import type { MessageBatch } from "@prisma/client";
import prisma from "../../db.server";
import { enqueueMany } from "../jobs/queue.server";
import type { Channel } from "./constants";

/** Hard ceiling on one batch, as a guard against a runaway segment. */
export const MAX_BATCH_RECIPIENTS = 10_000;

export interface CreateBatchInput {
  shop: string;
  channel: Channel;
  subject?: string | null;
  body: string;
  contactIds: string[];
  templateId?: string | null;
  createdByStaffId?: string | null;
  label?: string | null;
}

export interface CreateBatchResult {
  ok: boolean;
  error?: string;
  batch?: MessageBatch;
  enqueued?: number;
}

/**
 * Create the batch and fan out one job per recipient.
 *
 * Recipient ids are re-validated against the shop here rather than trusted from the form, so a
 * tampered request cannot address another tenant's contacts.
 */
export async function createBulkSend(input: CreateBatchInput): Promise<CreateBatchResult> {
  const unique = Array.from(new Set(input.contactIds));
  if (unique.length === 0) {
    return { ok: false, error: "No recipients to message." };
  }
  if (unique.length > MAX_BATCH_RECIPIENTS) {
    return {
      ok: false,
      error: `That's ${unique.length.toLocaleString()} recipients — the per-send limit is ${MAX_BATCH_RECIPIENTS.toLocaleString()}. Narrow the segment and try again.`,
    };
  }

  // Tenant re-validation: only ids that actually belong to this shop survive.
  const owned = await prisma.contact.findMany({
    where: { shop: input.shop, id: { in: unique } },
    select: { id: true },
  });
  if (owned.length === 0) {
    return { ok: false, error: "No recipients to message." };
  }

  const batch = await prisma.messageBatch.create({
    data: {
      shop: input.shop,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      templateId: input.templateId ?? null,
      createdByStaffId: input.createdByStaffId ?? null,
      label: input.label ?? null,
      total: owned.length,
      status: "RUNNING",
    },
  });

  const enqueued = await enqueueMany(
    owned.map((c) => ({
      shop: input.shop,
      type: "SEND_ONE" as const,
      payload: { batchId: batch.id, contactId: c.id },
      dedupeKey: `send:${batch.id}:${c.id}`,
    })),
  );

  return { ok: true, batch, enqueued };
}

/**
 * Recompute a batch's counters from its MessageLog rows and close it when every recipient has
 * reached a terminal state.
 *
 * Derived from the logs rather than incremented per send: an increment would drift whenever a job
 * retried, and the logs are the record of truth we would reconcile against anyway.
 */
export async function refreshBatchProgress(batchId: string): Promise<MessageBatch | null> {
  const batch = await prisma.messageBatch.findUnique({ where: { id: batchId } });
  if (!batch) return null;

  const rows = await prisma.messageLog.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row._count._all;

  const sent = counts.SENT ?? 0;
  const failed = counts.FAILED ?? 0;
  const skipped = counts.SKIPPED ?? 0;
  const settled = sent + failed + skipped;

  return prisma.messageBatch.update({
    where: { id: batchId },
    data: {
      sent,
      failed,
      skipped,
      status: settled >= batch.total ? "DONE" : "RUNNING",
    },
  });
}

/** Batch + live progress, for the bulk-send status UI. */
export async function getBatch(shop: string, batchId: string): Promise<MessageBatch | null> {
  return prisma.messageBatch.findFirst({ where: { id: batchId, shop } });
}

/** Recent bulk sends for this shop. */
export async function listBatches(shop: string, limit = 20): Promise<MessageBatch[]> {
  return prisma.messageBatch.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
