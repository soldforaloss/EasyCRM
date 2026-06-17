/**
 * Parse/serialize the Contacts list query (search, filters, sort, pagination) to and from
 * URLSearchParams. Pure — shared by the list loader and link-building UI.
 */

import { isLifecycleStage, type LifecycleStage } from "./constants";
import {
  CONTACT_SORT_FIELDS,
  DEFAULT_PAGE_SIZE,
  type ContactFilter,
  type ContactListParams,
  type ContactSortField,
} from "./types";

export function parseContactListParams(
  searchParams: URLSearchParams,
): ContactListParams {
  const sortRaw = searchParams.get("sort") ?? "updatedAt";
  const sortField: ContactSortField = (CONTACT_SORT_FIELDS as readonly string[]).includes(
    sortRaw,
  )
    ? (sortRaw as ContactSortField)
    : "updatedAt";

  const pageRaw = Number(searchParams.get("page") ?? "1");
  const sizeRaw = Number(searchParams.get("size") ?? String(DEFAULT_PAGE_SIZE));

  return {
    search: searchParams.get("q")?.trim() ?? "",
    stages: searchParams.getAll("stage").filter(isLifecycleStage) as LifecycleStage[],
    tagIds: searchParams.getAll("tag").filter(Boolean),
    spendTiers: searchParams.getAll("spend").filter(Boolean),
    sortField,
    sortDir: searchParams.get("dir") === "asc" ? "asc" : "desc",
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    pageSize: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : DEFAULT_PAGE_SIZE,
  };
}

/** Serialize params back to a query string (omitting defaults to keep URLs clean). */
export function contactListParamsToSearch(params: ContactListParams): URLSearchParams {
  const sp = new URLSearchParams();
  if (params.search) sp.set("q", params.search);
  for (const s of params.stages ?? []) sp.append("stage", s);
  for (const t of params.tagIds ?? []) sp.append("tag", t);
  for (const s of params.spendTiers ?? []) sp.append("spend", s);
  if (params.sortField !== "updatedAt") sp.set("sort", params.sortField);
  if (params.sortDir !== "desc") sp.set("dir", params.sortDir);
  if (params.page > 1) sp.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_PAGE_SIZE) sp.set("size", String(params.pageSize));
  return sp;
}

/** A ContactFilter (segment criteria) serialized to a query string for the list. */
export function filterToSearch(filter: ContactFilter): URLSearchParams {
  const sp = new URLSearchParams();
  if (filter.search) sp.set("q", filter.search);
  for (const s of filter.stages ?? []) sp.append("stage", s);
  for (const t of filter.tagIds ?? []) sp.append("tag", t);
  for (const s of filter.spendTiers ?? []) sp.append("spend", s);
  return sp;
}

/** Extract just the filter (no sort/pagination) — for saving a segment. */
export function paramsToFilter(params: ContactListParams): ContactFilter {
  return {
    search: params.search ?? "",
    stages: params.stages ?? [],
    tagIds: params.tagIds ?? [],
    spendTiers: params.spendTiers ?? [],
  };
}

/** True when any filter (beyond sort/pagination) is active. */
export function hasActiveFilter(params: ContactListParams): boolean {
  return Boolean(
    params.search ||
      (params.stages && params.stages.length) ||
      (params.tagIds && params.tagIds.length) ||
      (params.spendTiers && params.spendTiers.length),
  );
}
