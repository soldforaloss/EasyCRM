import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "./rate-limit.server";

const OPTIONS = { capacity: 3, refillPerSecond: 1 };

beforeEach(() => {
  resetRateLimits();
});

describe("rateLimit", () => {
  it("allows up to the burst capacity, then denies", () => {
    const now = 1_000_000;
    expect(rateLimit("k", OPTIONS, now).allowed).toBe(true);
    expect(rateLimit("k", OPTIONS, now).allowed).toBe(true);
    expect(rateLimit("k", OPTIONS, now).allowed).toBe(true);
    expect(rateLimit("k", OPTIONS, now).allowed).toBe(false);
  });

  it("refills over time", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) rateLimit("k", OPTIONS, now);
    expect(rateLimit("k", OPTIONS, now).allowed).toBe(false);

    // One second later, one token is back.
    expect(rateLimit("k", OPTIONS, now + 1000).allowed).toBe(true);
    expect(rateLimit("k", OPTIONS, now + 1000).allowed).toBe(false);
  });

  it("never refills beyond capacity", () => {
    const now = 1_000_000;
    rateLimit("k", OPTIONS, now);
    // An hour of idling should not grant more than the burst capacity.
    let allowed = 0;
    for (let i = 0; i < 10; i += 1) {
      if (rateLimit("k", OPTIONS, now + 3_600_000).allowed) allowed += 1;
    }
    expect(allowed).toBe(OPTIONS.capacity);
  });

  it("keeps buckets independent per key", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) rateLimit("a", OPTIONS, now);
    expect(rateLimit("a", OPTIONS, now).allowed).toBe(false);
    expect(rateLimit("b", OPTIONS, now).allowed).toBe(true);
  });

  it("reports a usable retry-after when throttled", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) rateLimit("k", OPTIONS, now);
    const denied = rateLimit("k", OPTIONS, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
