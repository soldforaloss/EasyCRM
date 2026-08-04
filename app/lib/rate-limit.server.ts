/**
 * In-memory token-bucket rate limiter for public endpoints. SERVER ONLY. See DECISIONS.md §12.
 *
 * SCOPE AND LIMITS — read before relying on this:
 * The state is per-process, so with N app instances the effective global limit is N × `capacity`.
 * That is acceptable for its purpose here, which is to stop a single misbehaving or malicious
 * caller from hammering one instance's database with token lookups. It is NOT a precise global
 * quota; if you need one, move the buckets to Redis or Postgres.
 *
 * Memory is bounded by evicting buckets that have been idle longer than their refill window, so
 * a flood of distinct keys cannot grow the map without limit.
 */

export interface RateLimitOptions {
  /** Maximum burst — tokens available when a bucket is full. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Whole tokens left after this call. */
  remaining: number;
  /** Seconds until at least one token is available (0 when allowed). */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** Drop buckets idle long enough to have fully refilled — they carry no information. */
function evictStale(now: number, options: RateLimitOptions): void {
  const idleMs = (options.capacity / options.refillPerSecond) * 1000;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > idleMs) buckets.delete(key);
  }
}

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Consume one token for `key`. Returns whether the call is allowed.
 *
 * `now` is injectable so tests can advance time without sleeping.
 */
export function rateLimit(
  key: string,
  options: RateLimitOptions,
  now: number = Date.now(),
): RateLimitResult {
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    lastSweep = now;
    evictStale(now, options);
  }

  const bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, { tokens: options.capacity - 1, updatedAt: now });
    return { allowed: true, remaining: options.capacity - 1, retryAfterSeconds: 0 };
  }

  const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
  const tokens = Math.min(
    options.capacity,
    bucket.tokens + elapsedSeconds * options.refillPerSecond,
  );

  if (tokens < 1) {
    bucket.tokens = tokens;
    bucket.updatedAt = now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / options.refillPerSecond)),
    };
  }

  bucket.tokens = tokens - 1;
  bucket.updatedAt = now;
  return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
}

/** Test helper — clears all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}
