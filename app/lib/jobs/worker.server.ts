/**
 * In-process background worker. SERVER ONLY. See DECISIONS.md §11.
 *
 * Runs inside the web server, which suits this app's deployment shape (a long-running Node
 * container — see the Dockerfile). Job claiming is an atomic compare-and-set, so scaling to
 * several web instances is safe: they share the queue without double-processing.
 *
 * `RUN_JOB_WORKER=false` disables the loop on a given instance.
 *
 * DEPLOYMENT CONSTRAINT: this requires a process that stays alive between requests. On a
 * platform that freezes or recycles the process per-request (Vercel/Lambda-style), jobs will not
 * drain — you would need a dedicated always-on worker process, which this build does not ship.
 * The provided Dockerfile deployment target does satisfy the constraint.
 */

import { randomUUID } from "crypto";
import { logger, reportError } from "../logger.server";
import { runJob } from "./handlers.server";
import { claimJobs, completeJob, failJob, reclaimStaleJobs } from "./queue.server";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH = 5;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface WorkerHandle {
  stop: () => void;
  /** Run exactly one tick. Exposed for tests and for the standalone runner's drain mode. */
  tick: () => Promise<number>;
}

let running: WorkerHandle | null = null;

/**
 * Process one batch of jobs. Returns how many were handled.
 *
 * Each job is isolated: one failing handler never aborts the tick, and the failure path itself is
 * wrapped, so a database blip while recording a failure cannot kill the worker loop.
 */
async function tickOnce(workerId: string, batchSize: number): Promise<number> {
  await reclaimStaleJobs();
  const jobs = await claimJobs(batchSize, workerId);
  if (jobs.length === 0) return 0;

  for (const job of jobs) {
    const startedAt = Date.now();
    try {
      await runJob(job);
      await completeJob(job.id);
      logger.info("job.done", {
        jobId: job.id,
        type: job.type,
        shop: job.shop,
        attempts: job.attempts,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      try {
        const { willRetry } = await failJob(job, error);
        await reportError("job.failed", error, {
          jobId: job.id,
          type: job.type,
          shop: job.shop,
          attempts: job.attempts,
          willRetry,
        });
      } catch (bookkeepingError) {
        await reportError("job.fail_bookkeeping_error", bookkeepingError, { jobId: job.id });
      }
    }
  }
  return jobs.length;
}

/**
 * Start the polling loop. Idempotent — a second call returns the existing handle, so React
 * Router's module re-evaluation in dev cannot spawn duplicate workers.
 *
 * Self-scheduling with setTimeout rather than setInterval: ticks can never overlap, so a slow
 * batch applies natural backpressure instead of piling up concurrent runs.
 */
export function startWorker(): WorkerHandle {
  if (running) return running;

  const workerId = randomUUID();
  const intervalMs = intFromEnv("JOB_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const batchSize = intFromEnv("JOB_WORKER_BATCH", DEFAULT_BATCH);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = () => tickOnce(workerId, batchSize);

  const loop = async () => {
    if (stopped) return;
    try {
      const handled = await tick();
      // Poll again immediately while there is a queue to drain; idle back off to the interval.
      timer = setTimeout(loop, handled > 0 ? 0 : intervalMs);
    } catch (error) {
      await reportError("job.worker_tick_error", error, { workerId });
      timer = setTimeout(loop, intervalMs);
    }
    timer?.unref?.(); // never hold the process open on this timer alone
  };

  logger.info("job.worker_started", { workerId, intervalMs, batchSize });
  timer = setTimeout(loop, intervalMs);
  timer?.unref?.();

  running = {
    tick,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      running = null;
      logger.info("job.worker_stopped", { workerId });
    },
  };
  return running;
}

/** Start the worker unless explicitly disabled. Called once from entry.server.tsx. */
export function startWorkerIfEnabled(): void {
  if (process.env.RUN_JOB_WORKER === "false") {
    logger.info("job.worker_disabled", { reason: "RUN_JOB_WORKER=false" });
    return;
  }
  startWorker();
}
