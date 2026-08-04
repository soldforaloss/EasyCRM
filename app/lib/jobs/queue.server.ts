/**
 * Durable, Postgres-backed job queue. SERVER ONLY. See DECISIONS.md §11.
 *
 * Deliberately DB-backed rather than Redis-backed: the app already requires Postgres, and adding
 * a second stateful dependency to a single-tenant-per-shop CRM is not worth the operational cost.
 * Throughput here is bounded by the Brevo API anyway, not by the queue.
 *
 * Concurrency safety: a job is claimed with an optimistic compare-and-set on `status`
 * (`updateMany where {id, status:"PENDING"}`). Exactly one worker's update can match, so several
 * app instances may run workers against the same table without double-processing. No advisory
 * locks or `SELECT ... FOR UPDATE` needed.
 */

import { randomUUID } from "crypto";
import type { Job } from "@prisma/client";
import prisma from "../../db.server";

export const JOB_TYPES = ["SEND_ONE", "BACKFILL_CUSTOMERS"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A job RUNNING longer than this is presumed dead (worker crashed) and is requeued. */
const STALE_LOCK_MS = 5 * 60 * 1000;

/** Retry backoff: 30s, 2m, 8m … capped. Applied on transient handler failure. */
function backoffMs(attempts: number): number {
  return Math.min(30_000 * 4 ** Math.max(0, attempts - 1), 30 * 60 * 1000);
}

export interface EnqueueInput {
  shop: string;
  type: JobType;
  payload: unknown;
  /**
   * Idempotency key, unique per shop. Re-enqueueing with the same key is a no-op, which is what
   * makes "retry the whole batch" and at-least-once webhook delivery safe.
   */
  dedupeKey?: string;
  maxAttempts?: number;
  runAt?: Date;
}

/** Add a job. Returns the job, or null when `dedupeKey` collided (already enqueued). */
export async function enqueueJob(input: EnqueueInput): Promise<Job | null> {
  try {
    return await prisma.job.create({
      data: {
        shop: input.shop,
        type: input.type,
        payload: JSON.stringify(input.payload ?? {}),
        dedupeKey: input.dedupeKey ?? null,
        maxAttempts: input.maxAttempts ?? 3,
        runAt: input.runAt ?? new Date(),
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return null; // duplicate dedupeKey
    throw error;
  }
}

/** Bulk enqueue. Uses `skipDuplicates` so a partially-enqueued batch can be safely replayed. */
export async function enqueueMany(inputs: EnqueueInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const result = await prisma.job.createMany({
    data: inputs.map((input) => ({
      shop: input.shop,
      type: input.type,
      payload: JSON.stringify(input.payload ?? {}),
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      runAt: input.runAt ?? new Date(),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Requeue jobs whose worker died mid-run. Called at the top of each worker tick — cheap, and it
 * means a crashed or redeployed instance never strands work.
 */
export async function reclaimStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  const result = await prisma.job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: cutoff } },
    data: { status: "PENDING", lockedAt: null, lockedBy: null },
  });
  return result.count;
}

/**
 * Atomically claim up to `limit` runnable jobs for this worker.
 *
 * Candidates are over-fetched because a peer worker may win any individual row; each is then
 * claimed with a guarded update and only the winners are returned.
 */
export async function claimJobs(limit: number, workerId: string = randomUUID()): Promise<Job[]> {
  const now = new Date();
  const candidates = await prisma.job.findMany({
    where: { status: "PENDING", runAt: { lte: now } },
    orderBy: { runAt: "asc" },
    take: limit * 3,
    select: { id: true },
  });

  const claimed: string[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    const result = await prisma.job.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: {
        status: "RUNNING",
        lockedAt: new Date(),
        lockedBy: workerId,
        attempts: { increment: 1 },
      },
    });
    if (result.count === 1) claimed.push(candidate.id);
  }
  if (claimed.length === 0) return [];
  return prisma.job.findMany({ where: { id: { in: claimed } } });
}

/** Mark a claimed job finished. */
export async function completeJob(id: string): Promise<void> {
  await prisma.job.update({
    where: { id },
    data: { status: "DONE", lockedAt: null, lockedBy: null, lastError: null },
  });
}

/**
 * Mark a claimed job failed. Retries with exponential backoff while attempts remain, otherwise
 * parks the job in FAILED for inspection (jobs are never silently dropped).
 */
export async function failJob(job: Job, error: unknown): Promise<{ willRetry: boolean }> {
  const message = error instanceof Error ? error.message : String(error);
  const willRetry = job.attempts < job.maxAttempts;
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: willRetry ? "PENDING" : "FAILED",
      runAt: willRetry ? new Date(Date.now() + backoffMs(job.attempts)) : job.runAt,
      lockedAt: null,
      lockedBy: null,
      lastError: message.slice(0, 2000),
    },
  });
  return { willRetry };
}

/** Parse a job's JSON payload into a typed shape. */
export function jobPayload<T>(job: Job): T {
  return JSON.parse(job.payload) as T;
}

/** Queue depth by status, for the health endpoint and the bulk-send UI. */
export async function queueStats(shop?: string) {
  const rows = await prisma.job.groupBy({
    by: ["status"],
    where: shop ? { shop } : undefined,
    _count: { _all: true },
  });
  const stats: Record<string, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
  for (const row of rows) stats[row.status] = row._count._all;
  return stats;
}
