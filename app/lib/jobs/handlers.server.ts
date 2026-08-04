/**
 * Job handlers — the actual work behind each Job.type. SERVER ONLY. See DECISIONS.md §11.
 *
 * A handler that THROWS is retried with backoff by the worker. A handler that returns normally
 * is done. So: transient problems (network, Brevo 5xx) must throw; permanent per-recipient
 * outcomes (no consent, bad address, Brevo 4xx) must NOT throw — they are already recorded on
 * the MessageLog row and retrying them would just burn attempts.
 */

import type { Job } from "@prisma/client";
import prisma from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { refreshBatchProgress } from "../crm/bulk.server";
import { prepareSend, sendOneToContact, type SenderPrep } from "../crm/messaging.server";
import { getCachedPrep, setCachedPrep } from "../crm/sender-cache.server";
import { backfillContacts, backfillOrders } from "../crm/mirror.server";
import { isChannel, type Channel } from "../crm/constants";
import { logger } from "../logger.server";
import { syncLocations, syncShopTimezone } from "../shopify/locations.server";
import { jobPayload, type JobType } from "./queue.server";

export interface SendOnePayload {
  batchId: string;
  contactId: string;
}

/** Sender preflight, reusing the shared short-lived cache so a big batch decrypts the key once. */
async function cachedPrep(shop: string, channel: Channel): Promise<SenderPrep> {
  const hit = getCachedPrep(shop, channel);
  if (hit) return hit;
  const prep = await prepareSend(shop, channel);
  setCachedPrep(shop, channel, prep);
  return prep;
}

/** Send one message as part of a batch, then refresh the batch's progress counters. */
async function handleSendOne(job: Job): Promise<void> {
  const { batchId, contactId } = jobPayload<SendOnePayload>(job);
  const batch = await prisma.messageBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    logger.warn("job.send_one.batch_missing", { jobId: job.id, batchId });
    return; // batch deleted (e.g. shop redacted) — nothing to do, do not retry
  }
  if (!isChannel(batch.channel)) {
    logger.error("job.send_one.bad_channel", { jobId: job.id, channel: batch.channel });
    return; // unprocessable, not transient
  }

  const prep = await cachedPrep(batch.shop, batch.channel);
  if (!prep.ok) {
    // Misconfigured sender (no key / no postal address). This IS worth retrying — the merchant
    // may be mid-way through fixing Settings — so throw and let the backoff handle it.
    throw new Error(`Sender not ready: ${prep.error}`);
  }

  const outcome = await sendOneToContact(
    batch.shop,
    {
      contactId,
      channel: batch.channel,
      subject: batch.subject ?? undefined,
      body: batch.body,
      templateId: batch.templateId,
      sentByStaffId: batch.createdByStaffId,
      batchId: batch.id,
    },
    prep,
  );

  await refreshBatchProgress(batch.id);

  // A transport failure is retriable; a skip/duplicate/blocked outcome is terminal and already
  // recorded on the MessageLog row.
  if (outcome.status === "FAILED") {
    throw new Error(outcome.error ?? "Send failed.");
  }
}

/** One-time mirror of a shop's existing customers, moved off the OAuth callback. */
async function handleBackfill(job: Job): Promise<void> {
  const { admin } = await unauthenticated.admin(job.shop);
  const locations = await syncLocations(admin, job.shop);
  const result = await backfillContacts(admin, job.shop);
  logger.info("job.backfill.done", {
    shop: job.shop,
    processed: result.processed,
    pages: result.pages,
    locations: locations.processed,
  });
}

/** Mirror the standard trailing 60-day Shopify order window into local orders and visits. */
async function handleOrderBackfill(job: Job): Promise<void> {
  const { admin } = await unauthenticated.admin(job.shop);
  await syncShopTimezone(admin, job.shop);
  const result = await backfillOrders(admin, job.shop);
  logger.info("job.backfill_orders.done", { shop: job.shop, ...result });
}

const HANDLERS: Record<JobType, (job: Job) => Promise<void>> = {
  SEND_ONE: handleSendOne,
  BACKFILL_CUSTOMERS: handleBackfill,
  BACKFILL_ORDERS: handleOrderBackfill,
};

/** Dispatch a claimed job to its handler. Throws for the worker to retry. */
export async function runJob(job: Job): Promise<void> {
  const handler = HANDLERS[job.type as JobType];
  if (!handler) {
    logger.error("job.unknown_type", { jobId: job.id, type: job.type });
    return; // unknown type — park it rather than retrying forever
  }
  await handler(job);
}
