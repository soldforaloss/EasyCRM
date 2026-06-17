/**
 * Brevo (Sendinblue) REST API client. SERVER ONLY — the merchant's BYOK API key and every
 * Brevo request stay server-side (see DECISIONS.md §5).
 *
 * Auth: `api-key` header (the REST API key, not the SMTP relay key).
 * Reliability: transient failures (HTTP 429 / 5xx / network errors) are retried with
 * exponential backoff honoring `Retry-After`. 4xx (other than 429) fail fast with a readable
 * message. `fetch`/`sleep` are injectable so the client is fully unit-testable with no network.
 */

import type {
  BrevoAccount,
  BrevoEmailRequest,
  BrevoEmailResponse,
  BrevoErrorBody,
  BrevoResult,
  BrevoSmsRequest,
  BrevoSmsResponse,
} from "./types";

export const BREVO_BASE_URL = "https://api.brevo.com/v3";

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface BrevoClientOptions {
  /** Defaults to global fetch. Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Max retry attempts for transient failures (default 2 → up to 3 tries total). */
  retries?: number;
  /** Base backoff delay in ms (default 500). */
  baseDelayMs?: number;
  /** Sleep function; injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY = 500;
const MAX_BACKOFF = 8000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function parseError(status: number, raw: string): { error: string; code?: string } {
  let body: BrevoErrorBody | undefined;
  try {
    body = raw ? (JSON.parse(raw) as BrevoErrorBody) : undefined;
  } catch {
    body = undefined;
  }
  const message =
    body?.message ||
    (raw && raw.length < 300 ? raw : undefined) ||
    `Brevo request failed with status ${status}.`;
  return { error: message, code: body?.code };
}

/** Core request with retry/backoff. Returns a normalized BrevoResult — never throws on HTTP. */
async function brevoRequest<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  opts: BrevoClientOptions = {},
): Promise<BrevoResult<T>> {
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const sleep = opts.sleep ?? defaultSleep;

  if (!apiKey || apiKey.trim() === "") {
    return {
      ok: false,
      status: 0,
      error: "No Brevo API key configured.",
      retriable: false,
    };
  }

  let attempt = 0;
  // total tries = retries + 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let status = 0;
    let rawBody = "";
    let retryAfterMs: number | undefined;
    try {
      const res = await fetchImpl(`${BREVO_BASE_URL}${path}`, {
        method,
        headers: {
          "api-key": apiKey,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      status = res.status;
      rawBody = await res.text();

      if (status >= 200 && status < 300) {
        const data = rawBody ? (JSON.parse(rawBody) as T) : ({} as T);
        return { ok: true, status, data };
      }

      const header = res.headers.get("retry-after");
      if (header) {
        const secs = Number(header);
        if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
      }
    } catch (err) {
      // Network/DNS/abort — treat as retriable transient error.
      status = 0;
      rawBody = err instanceof Error ? err.message : String(err);
    }

    const retriable = status === 0 || isRetriableStatus(status);
    if (retriable && attempt < retries) {
      const backoff = Math.min(retryAfterMs ?? baseDelay * 2 ** attempt, MAX_BACKOFF);
      await sleep(backoff);
      attempt += 1;
      continue;
    }

    const { error, code } =
      status === 0
        ? { error: `Network error contacting Brevo: ${rawBody}`, code: undefined }
        : parseError(status, rawBody);
    return { ok: false, status, error, code, retriable };
  }
}

/** Validate a Brevo API key by fetching the account (GET /v3/account). */
export function validateBrevoKey(
  apiKey: string,
  opts?: BrevoClientOptions,
): Promise<BrevoResult<BrevoAccount>> {
  return brevoRequest<BrevoAccount>(apiKey, "GET", "/account", undefined, opts);
}

/** Send a transactional email (POST /v3/smtp/email). Supports batch via messageVersions. */
export function sendBrevoEmail(
  apiKey: string,
  req: BrevoEmailRequest,
  opts?: BrevoClientOptions,
): Promise<BrevoResult<BrevoEmailResponse>> {
  return brevoRequest<BrevoEmailResponse>(apiKey, "POST", "/smtp/email", req, opts);
}

/** Send a transactional SMS (POST /v3/transactionalSMS/send). */
export function sendBrevoSms(
  apiKey: string,
  req: BrevoSmsRequest,
  opts?: BrevoClientOptions,
): Promise<BrevoResult<BrevoSmsResponse>> {
  return brevoRequest<BrevoSmsResponse>(
    apiKey,
    "POST",
    "/transactionalSMS/send",
    req,
    opts,
  );
}

/**
 * Format an E.164 number for Brevo's `recipient` field. Brevo expects the country code +
 * number; its examples omit the leading "+", so we strip it (digits only). See DECISIONS.md §7.
 */
export function toBrevoSmsRecipient(e164: string): string {
  return e164.replace(/^\+/, "");
}
