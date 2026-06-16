/**
 * Billing — intentionally a STUB (see DECISIONS.md §6 and brief §4).
 *
 * Billing is left out of the core build but isolated here so a recurring/usage plan can be
 * enabled later without reworking call sites. To turn it on:
 *   1. Add a `billing` config to `shopifyApp({ ... })` in app/shopify.server.ts, e.g.
 *        billing: { [APP_PLAN]: { amount: 19, currencyCode: "USD", interval: BillingInterval.Every30Days } }
 *   2. Replace the body of `requireActivePlan` below with the template's billing helper:
 *        const { billing } = await authenticate.admin(request);
 *        await billing.require({
 *          plans: [APP_PLAN],
 *          isTest: process.env.NODE_ENV !== "production",
 *          onFailure: async () => billing.request({ plan: APP_PLAN, isTest: true }),
 *        });
 *   3. Call `requireActivePlan(request)` at the top of the loaders you wish to gate.
 *
 * Until then it is a no-op so the app is fully usable without a plan.
 */

export const APP_PLAN = "Easy CRM Plan";

export interface PlanGateResult {
  active: boolean;
  /** When billing is disabled (the default), this is always true. */
  bypassReason?: string;
}

/**
 * Gate a request behind an active plan. No-op stub today (returns active=true).
 * Wire up the template's `billing.require` here when enabling billing.
 */
export async function requireActivePlan(_request: Request): Promise<PlanGateResult> {
  return { active: true, bypassReason: "Billing is not enabled in this build." };
}
