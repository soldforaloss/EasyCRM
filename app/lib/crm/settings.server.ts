/** General CRM settings access. SERVER ONLY. */

import prisma from "../../db.server";
import { LIFECYCLE_STAGES } from "./constants";

export interface CrmSettings {
  lifecycleStages: string[];
  ianaTimezone: string | null;
}

function parseLifecycleStages(value: string | null): string[] {
  if (!value) return [...LIFECYCLE_STAGES];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored lifecycle stage settings are not valid JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Stored lifecycle stage settings are invalid.");
  }

  const stages = parsed.map((stage) =>
    typeof stage === "string" ? stage.trim() : "",
  );
  if (
    stages.some((stage) => !stage) ||
    new Set(stages).size !== stages.length
  ) {
    throw new Error("Stored lifecycle stage settings are invalid.");
  }

  return stages;
}

export async function getCrmSettings(shop: string): Promise<CrmSettings> {
  const settings = await prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
    select: { lifecycleStages: true, ianaTimezone: true },
  });

  return {
    lifecycleStages: parseLifecycleStages(settings.lifecycleStages),
    ianaTimezone: settings.ianaTimezone,
  };
}
