/**
 * Brevo (formerly Sendinblue) REST API types — the subset this app uses.
 * Host: https://api.brevo.com/v3 — auth via the `api-key` header (REST key, not SMTP relay key).
 */

export interface BrevoContactRef {
  email: string;
  name?: string;
}

export interface BrevoSender {
  name?: string;
  email: string;
}

/** POST /v3/smtp/email */
export interface BrevoEmailRequest {
  sender: BrevoSender;
  to: BrevoContactRef[];
  subject?: string;
  htmlContent?: string;
  textContent?: string;
  params?: Record<string, unknown>;
  templateId?: number;
  /** Batch personalization — one version per recipient set in a single API call. */
  messageVersions?: Array<{
    to: BrevoContactRef[];
    subject?: string;
    htmlContent?: string;
    textContent?: string;
    params?: Record<string, unknown>;
  }>;
}

export interface BrevoEmailResponse {
  messageId?: string;
  messageIds?: string[];
}

/** POST /v3/transactionalSMS/send */
export interface BrevoSmsRequest {
  sender: string; // alphanumeric sender id (<= 11 chars) or a registered number
  recipient: string; // see toBrevoSmsRecipient()
  content: string;
  type?: "transactional" | "marketing";
  tag?: string;
}

export interface BrevoSmsResponse {
  reference?: string;
  messageId?: number;
  smsCount?: number;
  usedCredits?: number;
  remainingCredits?: number;
}

/** GET /v3/account */
export interface BrevoAccount {
  email?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  plan?: unknown;
}

/** Normalized result returned by every client call. */
export type BrevoResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string; retriable: boolean };

/** Brevo error envelope: { code, message }. */
export interface BrevoErrorBody {
  code?: string;
  message?: string;
}
