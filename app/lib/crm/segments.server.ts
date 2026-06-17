/** Saved segments (named list filters). `criteria` is JSON-as-String. SERVER ONLY. */

import prisma from "../../db.server";
import type { ContactFilter } from "./types";

export async function listSegments(shop: string) {
  return prisma.segment.findMany({
    where: { shop },
    orderBy: { name: "asc" },
  });
}

export async function getSegment(shop: string, id: string) {
  return prisma.segment.findFirst({ where: { shop, id } });
}

export function parseSegmentCriteria(criteria: string): ContactFilter {
  try {
    const parsed = JSON.parse(criteria) as ContactFilter;
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      stages: Array.isArray(parsed.stages) ? parsed.stages : [],
      tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds : [],
      spendTiers: Array.isArray(parsed.spendTiers) ? parsed.spendTiers : [],
    };
  } catch {
    return { search: "", stages: [], tagIds: [], spendTiers: [] };
  }
}

export async function createSegment(
  shop: string,
  name: string,
  criteria: ContactFilter,
) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Segment name is required.");
  return prisma.segment.upsert({
    where: { shop_name: { shop, name: trimmed } },
    update: { criteria: JSON.stringify(criteria) },
    create: { shop, name: trimmed, criteria: JSON.stringify(criteria) },
  });
}

export async function deleteSegment(shop: string, id: string): Promise<void> {
  await prisma.segment.deleteMany({ where: { shop, id } });
}
