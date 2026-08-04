/**
 * Liveness/readiness probe. Public by design — it exposes no shop data, only whether this
 * instance can serve traffic. See DECISIONS.md §12.
 *
 * Returns 200 when the database answers, 503 otherwise, so a load balancer or orchestrator can
 * pull a broken instance out of rotation instead of serving errors from it.
 */

import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { queueStats } from "../lib/jobs/queue.server";
import { logger } from "../lib/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // `?deep=1` additionally reports queue depth. Kept opt-in because it is a second query and
  // probes usually run every few seconds.
  const deep = url.searchParams.get("deep") === "1";

  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    logger.error("health.db_unreachable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { status: "error", database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const body: Record<string, unknown> = {
    status: "ok",
    database: "ok",
    dbLatencyMs: Date.now() - startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  };

  if (deep) {
    try {
      body.jobs = await queueStats();
    } catch {
      body.jobs = "unavailable";
    }
  }

  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
};
