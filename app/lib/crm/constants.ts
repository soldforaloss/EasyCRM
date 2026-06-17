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

export const MESSAGE_STATUSES = ["QUEUED", "SENT", "FAILED"] as const;
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
};

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
