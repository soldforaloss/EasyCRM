import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queueMock, runJobMock, loggerMock, reportErrorMock } = vi.hoisted(() => ({
  queueMock: {
    reclaimStaleJobs: vi.fn(),
    claimJobs: vi.fn(),
    renewJobLock: vi.fn(),
    completeJob: vi.fn(),
    failJob: vi.fn(),
  },
  runJobMock: vi.fn(),
  loggerMock: { info: vi.fn() },
  reportErrorMock: vi.fn(),
}));

vi.mock("./queue.server", () => queueMock);
vi.mock("./handlers.server", () => ({ runJob: runJobMock }));
vi.mock("../logger.server", () => ({ logger: loggerMock, reportError: reportErrorMock }));

import { startWorker } from "./worker.server";

function job() {
  return {
    id: "job-1",
    shop: "shop.myshopify.com",
    type: "BACKFILL_ORDERS",
    status: "RUNNING",
    payload: "{}",
    dedupeKey: null,
    attempts: 1,
    maxAttempts: 5,
    runAt: new Date(),
    lockedAt: new Date(),
    lockedBy: "worker",
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  queueMock.reclaimStaleJobs.mockResolvedValue(0);
  queueMock.renewJobLock.mockResolvedValue(true);
  queueMock.completeJob.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("worker leases", () => {
  it("renews the active job and claims the next job only after completion", async () => {
    let finishJob!: () => void;
    runJobMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishJob = resolve;
        }),
    );
    queueMock.claimJobs.mockResolvedValueOnce([job()]).mockResolvedValueOnce([]);

    const handle = startWorker();
    handle.stop();
    const tick = handle.tick();
    await vi.waitFor(() => expect(runJobMock).toHaveBeenCalledTimes(1));

    expect(queueMock.claimJobs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queueMock.renewJobLock).toHaveBeenCalledWith("job-1", expect.any(String));

    finishJob();
    expect(await tick).toBe(1);
    const workerId = queueMock.renewJobLock.mock.calls[0][1];
    expect(queueMock.completeJob).toHaveBeenCalledWith("job-1", workerId);
    expect(queueMock.claimJobs).toHaveBeenCalledTimes(2);
  });
});
