/**
 * Central CRM enumerations and their display metadata.
 *
 * These "enums" are stored as plain `String` columns in Prisma (SQLite has no native enum
 * support — see DECISIONS.md §2). The `as const` arrays below are the single source of truth;
 * use the exported type guards to validate untrusted input before persisting.
 *
 * This module is pure (no DB, no env, no Shopify) so it is safe to import from both server
 * and client code.
 */

/** Valid `tone` values for the Polaris `<s-badge>` web component. */
export type BadgeTone =
  | "auto"
  | "neutral"
  | "info"
  | "success"
  | "caution"
  | "warning"
  | "critical";

/** Subset of Polaris `<s-icon>` icon names used by the CRM (all valid IconType members). */
export type IconName =
  | "note"
  | "email"
  | "chat"
  | "cart"
  | "flag"
  | "calendar"
  | "info"
  | "person"
  | "clock"
  | "order"
  | "delete"
  | "x";

/* ------------------------------------------------------------------ */
/* Lifecycle stage                                                     */
/* ------------------------------------------------------------------ */

export const LIFECYCLE_STAGES = [
  "LEAD",
  "PROSPECT",
  "CUSTOMER",
  "VIP",
  "CHURNED",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export const DEFAULT_LIFECYCLE_STAGE: LifecycleStage = "LEAD";

export const LIFECYCLE_STAGE_META: Record<
  LifecycleStage,
  { label: string; tone: BadgeTone; color?: "base" | "strong" }
> = {
  LEAD: { label: "Lead", tone: "info" },
  PROSPECT: { label: "Prospect", tone: "caution" },
  CUSTOMER: { label: "Customer", tone: "success" },
  VIP: { label: "VIP", tone: "success", color: "strong" },
  CHURNED: { label: "Churned", tone: "critical" },
};

export function isLifecycleStage(v: unknown): v is LifecycleStage {
  return (
    typeof v === "string" &&
    (LIFECYCLE_STAGES as readonly string[]).includes(v)
  );
}

export function lifecycleStageLabel(v: string): string {
  return isLifecycleStage(v) ? LIFECYCLE_STAGE_META[v].label : v;
}

/* ------------------------------------------------------------------ */
/* Location / visit foundation                                         */
/* ------------------------------------------------------------------ */

export const VISIT_SOURCES = ["POS_ORDER"] as const;
export type VisitSource = (typeof VISIT_SOURCES)[number];

export const CONTACT_PREFERENCE_KEYS = ["SHIRT_SIZE", "SHOE_SIZE"] as const;
export type ContactPreferenceKey = (typeof CONTACT_PREFERENCE_KEYS)[number];

export function isContactPreferenceKey(v: unknown): v is ContactPreferenceKey {
  return (
    typeof v === "string" &&
    (CONTACT_PREFERENCE_KEYS as readonly string[]).includes(v)
  );
}

export const CONTACT_PREFERENCE_SOURCES = ["DERIVED", "MANUAL"] as const;
export type ContactPreferenceSource = (typeof CONTACT_PREFERENCE_SOURCES)[number];

/* ------------------------------------------------------------------ */
/* Activity (timeline) type                                            */
/* ------------------------------------------------------------------ */

export const ACTIVITY_TYPES = [
  "NOTE",
  "EMAIL_SENT",
  "SMS_SENT",
  "EMAIL_RECEIVED",
  "SMS_RECEIVED",
  "ORDER_PLACED",
  "STAGE_CHANGED",
  "TASK",
  "OUTREACH_CALL",
  "OUTREACH_IN_PERSON",
  "OUTREACH_TEXT",
  "SYSTEM",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export function isActivityType(v: unknown): v is ActivityType {
  return typeof v === "string" && (ACTIVITY_TYPES as readonly string[]).includes(v);
}

export const ACTIVITY_TYPE_META: Record<
  ActivityType,
  { label: string; icon: IconName }
> = {
  NOTE: { label: "Note", icon: "note" },
  EMAIL_SENT: { label: "Email sent", icon: "email" },
  SMS_SENT: { label: "SMS sent", icon: "chat" },
  EMAIL_RECEIVED: { label: "Email received", icon: "email" },
  SMS_RECEIVED: { label: "SMS received", icon: "chat" },
  ORDER_PLACED: { label: "Order placed", icon: "cart" },
  STAGE_CHANGED: { label: "Stage changed", icon: "flag" },
  TASK: { label: "Task", icon: "calendar" },
  OUTREACH_CALL: { label: "Call logged", icon: "chat" },
  OUTREACH_IN_PERSON: { label: "In-person conversation", icon: "person" },
  OUTREACH_TEXT: { label: "Text logged", icon: "chat" },
  SYSTEM: { label: "System", icon: "info" },
};

/* ------------------------------------------------------------------ */
/* Task status                                                         */
/* ------------------------------------------------------------------ */

export const TASK_STATUSES = ["OPEN", "DONE"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: BadgeTone }> = {
  OPEN: { label: "Open", tone: "info" },
  DONE: { label: "Done", tone: "success" },
};

/* ------------------------------------------------------------------ */
/* Messaging channel                                                   */
/* ------------------------------------------------------------------ */

export const CHANNELS = ["EMAIL", "SMS"] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

export const CHANNEL_META: Record<Channel, { label: string; icon: IconName }> = {
  EMAIL: { label: "Email", icon: "email" },
  SMS: { label: "SMS", icon: "chat" },
};

/* ------------------------------------------------------------------ */
/* Message direction (outbound = we sent it; inbound = customer reply) */
/* ------------------------------------------------------------------ */

export const MESSAGE_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export function isMessageDirection(v: unknown): v is MessageDirection {
  return (
    typeof v === "string" && (MESSAGE_DIRECTIONS as readonly string[]).includes(v)
  );
}

/* ------------------------------------------------------------------ */
/* Message log status                                                  */
/* ------------------------------------------------------------------ */

export const MESSAGE_STATUSES = ["QUEUED", "SENT", "FAILED", "SKIPPED"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export function isMessageStatus(v: unknown): v is MessageStatus {
  return (
    typeof v === "string" && (MESSAGE_STATUSES as readonly string[]).includes(v)
  );
}

export const MESSAGE_STATUS_META: Record<MessageStatus, { label: string; tone: BadgeTone }> = {
  QUEUED: { label: "Queued", tone: "info" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "critical" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
};

/* ------------------------------------------------------------------ */
/* Skip reasons (why a send was suppressed before it was attempted)    */
/* ------------------------------------------------------------------ */

export const SKIP_REASONS = ["NO_CONSENT", "NO_ADDRESS", "INVALID_PHONE"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_META: Record<SkipReason, { label: string }> = {
  NO_CONSENT: { label: "Not subscribed to marketing" },
  NO_ADDRESS: { label: "No address on file" },
  INVALID_PHONE: { label: "Phone number unusable" },
};

/* ------------------------------------------------------------------ */
/* Marketing consent                                                   */
/* ------------------------------------------------------------------ */

/**
 * Shopify marketing states (CustomerEmailMarketingState / CustomerSmsMarketingState).
 *
 * ONLY `SUBSCRIBED` permits marketing contact. Everything else — including `PENDING`
 * (double opt-in not yet confirmed) and `NOT_SUBSCRIBED` — does not. A NULL/unknown value means
 * the mirror has never been synced and is likewise treated as no consent: this gate fails
 * CLOSED by design, because the cost of a wrong "allow" is a CAN-SPAM/TCPA/GDPR violation for
 * the merchant, while the cost of a wrong "deny" is one unsent message.
 *
 * See DECISIONS.md §10.
 */
export const CONSENT_SUBSCRIBED = "SUBSCRIBED";

/** True only when this state grants permission to send marketing messages. */
export function hasMarketingConsent(state: string | null | undefined): boolean {
  return state === CONSENT_SUBSCRIBED;
}

/** Human-readable consent label for the UI. */
export function consentLabel(state: string | null | undefined): string {
  if (!state) return "Unknown";
  return state
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Badge tone for a consent state — green only when sending is actually permitted. */
export function consentTone(state: string | null | undefined): BadgeTone {
  if (hasMarketingConsent(state)) return "success";
  if (state === "PENDING") return "caution";
  return "critical";
}

/** The consent field that governs a given channel. */
export function consentStateFor(
  channel: Channel,
  contact: { emailMarketingState?: string | null; smsMarketingState?: string | null },
): string | null {
  return (
    (channel === "EMAIL" ? contact.emailMarketingState : contact.smsMarketingState) ?? null
  );
}

/** True when `contact` may be sent a marketing message on `channel`. */
export function canReceive(
  channel: Channel,
  contact: { emailMarketingState?: string | null; smsMarketingState?: string | null },
): boolean {
  return hasMarketingConsent(consentStateFor(channel, contact));
}

/* ------------------------------------------------------------------ */
/* Spend tiers (numeric buckets over the cached Contact.amountSpent)   */
/* ------------------------------------------------------------------ */

export interface SpendTier {
  id: string;
  label: string;
  /** Inclusive lower bound. */
  gte: number;
  /** Exclusive upper bound, or null for "and up". */
  lt: number | null;
}

export const SPEND_TIERS: readonly SpendTier[] = [
  { id: "NONE", label: "No spend", gte: 0, lt: 0.01 },
  { id: "LOW", label: "Under $100", gte: 0.01, lt: 100 },
  { id: "MEDIUM", label: "$100–$499", gte: 100, lt: 500 },
  { id: "HIGH", label: "$500–$1,999", gte: 500, lt: 2000 },
  { id: "TOP", label: "$2,000+", gte: 2000, lt: null },
] as const;

export function spendTierOf(amount: number | null | undefined): SpendTier {
  const value = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  for (const tier of SPEND_TIERS) {
    if (value >= tier.gte && (tier.lt === null || value < tier.lt)) {
      return tier;
    }
  }
  return SPEND_TIERS[0];
}

export function spendTierById(id: string): SpendTier | undefined {
  return SPEND_TIERS.find((t) => t.id === id);
}
