/**
 * Shared CRM TypeScript contracts used across loaders, actions, server modules and UI.
 * Pure types only — safe to import anywhere.
 */

import type { Channel, LifecycleStage } from "./constants";

/* ------------------------------------------------------------------ */
/* Contact list / filtering / sorting                                  */
/* ------------------------------------------------------------------ */

export const CONTACT_SORT_FIELDS = [
  "name",
  "email",
  "createdAt",
  "updatedAt",
  "amountSpent",
  "ordersCount",
  "lastOrderAt",
  "lifecycleStage",
] as const;
export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number];

export type SortDirection = "asc" | "desc";

/** Describes a saved/active list filter. Serialized into `Segment.criteria` (JSON-as-String). */
export interface ContactFilter {
  /** Free-text search across name / email / phone. */
  search?: string;
  stages?: LifecycleStage[];
  tagIds?: string[];
  /** SpendTier ids (see constants.SPEND_TIERS). */
  spendTiers?: string[];
}

export interface ContactListParams extends ContactFilter {
  sortField: ContactSortField;
  sortDir: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 25;

export function emptyContactFilter(): ContactFilter {
  return { search: "", stages: [], tagIds: [], spendTiers: [] };
}

/* ------------------------------------------------------------------ */
/* Merge variables (templating)                                        */
/* ------------------------------------------------------------------ */

export type MergeVars = Record<string, string | number | null | undefined>;

/** The standard merge variables offered in the compose UI. */
export const MERGE_VARIABLES: ReadonlyArray<{
  key: string;
  label: string;
  sample: string;
}> = [
  { key: "firstName", label: "First name", sample: "Jordan" },
  { key: "lastName", label: "Last name", sample: "Rivera" },
  { key: "fullName", label: "Full name", sample: "Jordan Rivera" },
  { key: "email", label: "Email", sample: "jordan@example.com" },
  { key: "phone", label: "Phone", sample: "+15551234567" },
  { key: "lastOrderTotal", label: "Last order total", sample: "$84.00" },
  { key: "lastOrderDate", label: "Last order date", sample: "Jun 1, 2026" },
  { key: "ordersCount", label: "Number of orders", sample: "3" },
  { key: "totalSpent", label: "Total spent", sample: "$240.00" },
] as const;

/** Build a sample context from MERGE_VARIABLES for preview placeholders. */
export function sampleMergeVars(): MergeVars {
  return Object.fromEntries(MERGE_VARIABLES.map((v) => [v.key, v.sample]));
}

/* ------------------------------------------------------------------ */
/* Channel-tagged compose payloads                                     */
/* ------------------------------------------------------------------ */

export interface ComposeEmail {
  channel: Extract<Channel, "EMAIL">;
  subject: string;
  body: string;
}

export interface ComposeSms {
  channel: Extract<Channel, "SMS">;
  body: string;
}

export type ComposePayload = ComposeEmail | ComposeSms;
