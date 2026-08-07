/**
 * Shared CRM TypeScript contracts used across loaders, actions, server modules and UI.
 * Pure types only — safe to import anywhere.
 */

import type { LifecycleStage } from "./constants";

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
  /** Shopify location legacy ids represented by ContactLocation rollups. */
  locationIds?: string[];
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
  return {
    search: "",
    stages: [],
    tagIds: [],
    locationIds: [],
    spendTiers: [],
  };
}
