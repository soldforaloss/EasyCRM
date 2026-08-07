/** Job handlers for Shopify mirror backfills. SERVER ONLY. */

import type { Job } from "@prisma/client";
import { unauthenticated } from "../../shopify.server";
import { backfillContacts, backfillOrders } from "../crm/mirror.server";
import { logger } from "../logger.server";
import { syncLocations, syncShopTimezone } from "../shopify/locations.server";
import type { JobType } from "./queue.server";

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
