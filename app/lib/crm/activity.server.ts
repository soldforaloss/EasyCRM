/**
 * Activity timeline helpers. SERVER ONLY.
 * Activities are append-only events. `payload` is JSON-as-String (see DECISIONS.md §2).
 */

import type { Activity } from "@prisma/client";
import prisma from "../../db.server";
import type { ActivityType } from "./constants";

export interface LogActivityInput {
  shop: string;
  contactId: string;
  type: ActivityType;
  payload?: unknown;
  occurredAt?: Date;
}

export async function logActivity(input: LogActivityInput): Promise<Activity> {
  return prisma.activity.create({
    data: {
      shop: input.shop,
      contactId: input.contactId,
      type: input.type,
      payload: input.payload !== undefined ? JSON.stringify(input.payload) : null,
      occurredAt: input.occurredAt ?? new Date(),
    },
  });
}

export async function listActivities(
  shop: string,
  contactId: string,
  limit = 100,
): Promise<Activity[]> {
  return prisma.activity.findMany({
    where: { shop, contactId },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
}

/** Safely parse an activity's JSON payload into a typed object. */
export function parseActivityPayload<T = Record<string, unknown>>(
  activity: Pick<Activity, "payload">,
): T | null {
  if (!activity.payload) return null;
  try {
    return JSON.parse(activity.payload) as T;
  } catch {
    return null;
  }
}

/** Recent activity across all contacts for a shop (dashboard feed). */
export async function listRecentActivity(shop: string, limit = 12) {
  return prisma.activity.findMany({
    where: { shop },
    orderBy: { occurredAt: "desc" },
    take: limit,
    include: {
      contact: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });
}
