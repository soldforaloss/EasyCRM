import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    job: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  jobPayload,
  reclaimStaleJobs,
  renewJobLock,
} from "./queue.server";

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "j1",
    shop: "s",
    type: "BACKFILL_CUSTOMERS",
    status: "RUNNING",
    payload: JSON.stringify({ cursor: "page-2" }),
    dedupeKey: null,
    attempts: 1,
    maxAttempts: 3,
    runAt: new Date("2026-01-01T00:00:00Z"),
    lockedAt: new Date(),
    lockedBy: "w1",
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enqueueJob", () => {
  it("serializes the payload", async () => {
    prismaMock.job.create.mockResolvedValue(job());
    await enqueueJob({ shop: "s", type: "BACKFILL_CUSTOMERS", payload: { cursor: "page-2" } });
    expect(prismaMock.job.create.mock.calls[0][0].data.payload).toBe('{"cursor":"page-2"}');
  });

  it("returns null instead of throwing when the dedupe key collides", async () => {
    // This is what makes "enqueue the batch again" and duplicate webhook delivery safe.
    prismaMock.job.create.mockRejectedValue({ code: "P2002" });
    const result = await enqueueJob({
      shop: "s",
      type: "BACKFILL_CUSTOMERS",
      payload: {},
      dedupeKey: "backfill:initial",
    });
    expect(result).toBeNull();
  });

  it("propagates unexpected database errors", async () => {
    prismaMock.job.create.mockRejectedValue(new Error("connection lost"));
    await expect(
      enqueueJob({ shop: "s", type: "BACKFILL_ORDERS", payload: {} }),
    ).rejects.toThrow("connection lost");
  });
});

describe("claimJobs", () => {
  it("only returns jobs whose guarded update won the race", async () => {
    prismaMock.job.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }] as never)
      .mockResolvedValueOnce([job({ id: "a" })] as never);
    // "a" is claimed by us; "b" was taken by a peer worker between the read and the update.
    prismaMock.job.updateMany
      .mockResolvedValueOnce({ count: 1 } as never)
      .mockResolvedValueOnce({ count: 0 } as never);

    const claimed = await claimJobs(5, "worker-1");

    expect(claimed).toHaveLength(1);
    expect(prismaMock.job.findMany.mock.calls[1][0].where).toEqual({ id: { in: ["a"] } });
  });

  it("guards the claim on status so two workers cannot take the same job", async () => {
    prismaMock.job.findMany
      .mockResolvedValueOnce([{ id: "a" }] as never)
      .mockResolvedValueOnce([job({ id: "a" })] as never);
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 } as never);

    await claimJobs(1, "worker-1");

    const where = prismaMock.job.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "a", status: "PENDING" });
  });

  it("stops claiming once the limit is reached", async () => {
    prismaMock.job.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }, { id: "c" }] as never)
      .mockResolvedValueOnce([job({ id: "a" })] as never);
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 } as never);

    await claimJobs(1, "worker-1");

    expect(prismaMock.job.updateMany).toHaveBeenCalledTimes(1);
  });

  it("skips the second query when nothing was claimed", async () => {
    prismaMock.job.findMany.mockResolvedValueOnce([{ id: "a" }] as never);
    prismaMock.job.updateMany.mockResolvedValue({ count: 0 } as never);

    expect(await claimJobs(5, "worker-1")).toEqual([]);
    expect(prismaMock.job.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("failJob", () => {
  it("requeues with backoff while attempts remain", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 } as never);
    const { willRetry, updated } = await failJob(
      job({ attempts: 1, maxAttempts: 3 }),
      new Error("boom"),
      "w1",
    );

    expect(willRetry).toBe(true);
    expect(updated).toBe(true);
    const call = prismaMock.job.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "j1", status: "RUNNING", lockedBy: "w1" });
    const data = call.data;
    expect(data.status).toBe("PENDING");
    expect(data.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(data.lastError).toBe("boom");
  });

  it("parks the job as FAILED once attempts are exhausted", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 } as never);
    const { willRetry } = await failJob(
      job({ attempts: 3, maxAttempts: 3 }),
      new Error("boom"),
      "w1",
    );

    expect(willRetry).toBe(false);
    expect(prismaMock.job.updateMany.mock.calls[0][0].data.status).toBe("FAILED");
  });

  it("truncates very long error messages", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 } as never);
    await failJob(job(), new Error("x".repeat(5000)), "w1");
    expect(prismaMock.job.updateMany.mock.calls[0][0].data.lastError.length).toBe(2000);
  });

  it("does not overwrite a job after this worker loses the lease", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 0 } as never);
    const result = await failJob(job(), new Error("boom"), "old-worker");
    expect(result.updated).toBe(false);
  });
});

describe("reclaimStaleJobs", () => {
  it("requeues jobs whose worker died mid-run", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 2 } as never);
    expect(await reclaimStaleJobs()).toBe(2);

    const call = prismaMock.job.updateMany.mock.calls[0][0];
    expect(call.where.status).toBe("RUNNING");
    expect(call.data.status).toBe("PENDING");
    expect(call.data.lockedBy).toBeNull();
  });
});

describe("completeJob", () => {
  it("clears the lock and the last error only for the owning worker", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 } as never);
    expect(await completeJob("j1", "w1")).toBe(true);
    const call = prismaMock.job.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "j1", status: "RUNNING", lockedBy: "w1" });
    const data = call.data;
    expect(data).toMatchObject({ status: "DONE", lockedAt: null, lockedBy: null, lastError: null });
  });

  it("returns false after ownership changes", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 0 } as never);
    expect(await completeJob("j1", "old-worker")).toBe(false);
  });
});

describe("renewJobLock", () => {
  it("refreshes only the owning worker's running job", async () => {
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 } as never);
    expect(await renewJobLock("j1", "w1")).toBe(true);
    const call = prismaMock.job.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "j1", status: "RUNNING", lockedBy: "w1" });
    expect(call.data.lockedAt).toBeInstanceOf(Date);
  });
});

describe("jobPayload", () => {
  it("parses the stored JSON", () => {
    expect(jobPayload<{ cursor: string }>(job())).toEqual({ cursor: "page-2" });
  });
});
