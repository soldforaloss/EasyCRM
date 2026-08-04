/**
 * Structured logging + error reporting. SERVER ONLY. See DECISIONS.md §12.
 *
 * Emits one JSON object per line, which is what every log aggregator (CloudWatch, Datadog, Loki,
 * Fly, Render) expects — the previous free-text `console.log` calls were unsearchable and could
 * not be alerted on.
 *
 * Error reporting degrades gracefully: if `SENTRY_DSN` is set AND `@sentry/node` is installed,
 * `reportError` forwards there; otherwise it logs at error level. Sentry is intentionally an
 * optional peer rather than a hard dependency so the app installs and runs without it.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw ?? "")
    ? (raw as LogLevel)
    : process.env.NODE_ENV === "production"
      ? "info"
      : "debug";
}

/** Fields that must never reach the logs, matched case-insensitively on the key. */
const REDACT_PATTERN = /(api[-_]?key|secret|token|password|authorization|accessToken)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, event: string, context?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel()]) return;
  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  });
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const logger = {
  debug: (event: string, context?: Record<string, unknown>) => emit("debug", event, context),
  info: (event: string, context?: Record<string, unknown>) => emit("info", event, context),
  warn: (event: string, context?: Record<string, unknown>) => emit("warn", event, context),
  error: (event: string, context?: Record<string, unknown>) => emit("error", event, context),
};

/* ------------------------------------------------------------------ */
/* Error reporting                                                     */
/* ------------------------------------------------------------------ */

type SentryLike = {
  init: (options: Record<string, unknown>) => void;
  captureException: (error: unknown, hint?: Record<string, unknown>) => void;
};

let sentry: SentryLike | null = null;
let sentryTried = false;

async function getSentry(): Promise<SentryLike | null> {
  if (sentryTried) return sentry;
  sentryTried = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  try {
    // Optional dependency. The specifier is held in a variable so neither TypeScript nor Vite
    // tries to resolve it at build time — the package is genuinely allowed to be absent.
    const specifier = "@sentry/node";
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as SentryLike;
    mod.init({
      dsn,
      environment: process.env.NODE_ENV ?? "development",
      tracesSampleRate: 0,
    });
    sentry = mod;
    logger.info("observability.sentry_enabled");
  } catch {
    logger.warn("observability.sentry_unavailable", {
      hint: "SENTRY_DSN is set but @sentry/node is not installed. Run: npm i @sentry/node",
    });
    sentry = null;
  }
  return sentry;
}

/**
 * Report an unexpected error. Always logs; additionally forwards to Sentry when configured.
 * Never throws — a failure in error reporting must not mask the original error.
 */
export async function reportError(
  event: string,
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error(event, { ...context, message, stack });
  try {
    const client = await getSentry();
    client?.captureException(error, { extra: { event, ...context } });
  } catch {
    // Reporting the reporting failure would be circular — swallow it.
  }
}
