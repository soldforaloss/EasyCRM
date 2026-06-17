/**
 * Derived per-customer CRM insights (AOV, recency, tenure, order frequency, at-risk, top
 * products). Pure and unit-testable — computed server-side in the detail loader from live
 * Shopify data, then passed to the UI.
 */

export interface InsightsInput {
  /** Lifetime spend (authoritative, from Shopify amountSpent). */
  amountSpent: number;
  /** Lifetime order count (authoritative, from Shopify numberOfOrders). */
  numberOfOrders: number;
  /** Customer record creation date (ISO) — "customer since". */
  customerSince: string | null;
  /** Earliest order date (ISO). */
  firstOrderAt: string | null;
  /** Most recent order date (ISO). */
  lastOrderAt: string | null;
  /** Loaded orders (a recent page) — used to aggregate top products. */
  orders: Array<{ lineItems: Array<{ title: string; quantity: number }> }>;
}

export interface TopProduct {
  title: string;
  quantity: number;
}

export interface CustomerInsights {
  /** Average order value = lifetime spend / order count (0 when no orders). */
  aov: number;
  daysSinceLastOrder: number | null;
  tenureDays: number | null;
  /** Average days between orders (null when fewer than 2 orders or dates missing). */
  avgDaysBetweenOrders: number | null;
  /** True when the customer has gone notably longer than usual without ordering. */
  atRisk: boolean;
  /** Most-purchased products across the loaded orders (top 5 by quantity). */
  topProducts: TopProduct[];
}

const DAY_MS = 86_400_000;

function daysBetween(fromISO: string, to: Date): number {
  const from = new Date(fromISO);
  if (Number.isNaN(from.getTime())) return 0;
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

export function topProductsFrom(
  orders: InsightsInput["orders"],
  limit = 5,
): TopProduct[] {
  const totals = new Map<string, number>();
  for (const order of orders) {
    for (const li of order.lineItems ?? []) {
      if (!li.title) continue;
      totals.set(li.title, (totals.get(li.title) ?? 0) + (li.quantity || 0));
    }
  }
  return [...totals.entries()]
    .map(([title, quantity]) => ({ title, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export function computeInsights(
  input: InsightsInput,
  now: Date = new Date(),
): CustomerInsights {
  const aov = input.numberOfOrders > 0 ? input.amountSpent / input.numberOfOrders : 0;

  const daysSinceLastOrder = input.lastOrderAt
    ? daysBetween(input.lastOrderAt, now)
    : null;
  const tenureDays = input.customerSince ? daysBetween(input.customerSince, now) : null;

  let avgDaysBetweenOrders: number | null = null;
  if (input.numberOfOrders >= 2 && input.firstOrderAt && input.lastOrderAt) {
    const span = new Date(input.lastOrderAt).getTime() - new Date(input.firstOrderAt).getTime();
    if (span > 0) {
      avgDaysBetweenOrders = Math.round(span / DAY_MS / (input.numberOfOrders - 1));
    }
  }

  const atRisk =
    input.numberOfOrders >= 2 &&
    daysSinceLastOrder !== null &&
    avgDaysBetweenOrders !== null &&
    avgDaysBetweenOrders > 0 &&
    daysSinceLastOrder > 2 * avgDaysBetweenOrders;

  return {
    aov,
    daysSinceLastOrder,
    tenureDays,
    avgDaysBetweenOrders,
    atRisk,
    topProducts: topProductsFrom(input.orders),
  };
}
