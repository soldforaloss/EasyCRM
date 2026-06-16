/**
 * Maintains the local Contact mirror from Shopify webhooks + install backfill. SERVER ONLY.
 * All handlers are idempotent (upsert / dedupe) so duplicate webhook deliveries are safe
 * (see DECISIONS.md / brief §3).
 */

import prisma from "../../db.server";
import { parseMoney } from "../format";
import { logActivity } from "./activity.server";
import {
  iterateCustomers,
  type AdminGraphqlClient,
} from "../shopify/customers.server";

export interface CustomerWebhookPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  total_spent?: string | null;
  orders_count?: number | string | null;
  currency?: string | null;
}

export interface OrderWebhookPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string | null;
  created_at?: string | null;
  total_price?: string | null;
  currency?: string | null;
  customer?: CustomerWebhookPayload | null;
}

function customerGid(p: CustomerWebhookPayload): string | null {
  if (p.admin_graphql_api_id) return p.admin_graphql_api_id;
  if (p.id != null) return `gid://shopify/Customer/${p.id}`;
  return null;
}

function orderGid(p: OrderWebhookPayload): string {
  if (p.admin_graphql_api_id) return p.admin_graphql_api_id;
  return `gid://shopify/Order/${p.id}`;
}

function toInt(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Upsert the mirror from a customers/create|update webhook. Preserves CRM-owned fields. */
export async function upsertContactFromWebhook(
  shop: string,
  payload: CustomerWebhookPayload,
): Promise<void> {
  const gid = customerGid(payload);
  if (!gid) return;

  // Only mirror identity fields. Never touch lifecycleStage / ownerStaffId / source / tags.
  //
  // Spend signals (amountSpent / ordersCount / currencyCode) are intentionally NOT written here:
  // Shopify removed total_spent / orders_count / last_order_* from the customer webhook payload
  // (2025-01+), and mixing absolute writes with the orders/* increments below would let the
  // cache drift. Spend is maintained by the install backfill (absolute) + orders/* increments.
  // See DECISIONS.md §3.
  const mirrored = {
    firstName: payload.first_name ?? null,
    lastName: payload.last_name ?? null,
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    lastSyncedAt: new Date(),
  };

  await prisma.contact.upsert({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: gid } },
    update: mirrored,
    create: { shop, shopifyCustomerId: gid, ...mirrored },
  });
}

/** Remove a contact (and cascaded CRM data) from a customers/delete webhook. Idempotent. */
export async function deleteContactFromWebhook(
  shop: string,
  payload: CustomerWebhookPayload,
): Promise<void> {
  const gid = customerGid(payload);
  if (!gid) return;
  await prisma.contact.deleteMany({
    where: { shop, shopifyCustomerId: gid },
  });
}

/**
 * Append an ORDER_PLACED timeline event and bump cached spend signals from an orders/* webhook.
 * Idempotent: a duplicate delivery of the same order is detected and ignored.
 */
export async function recordOrderFromWebhook(
  shop: string,
  payload: OrderWebhookPayload,
): Promise<void> {
  const customer = payload.customer;
  if (!customer) return; // guest checkout — no contact to attach to
  const gid = customerGid(customer);
  if (!gid) return;

  const oGid = orderGid(payload);

  // Ensure the contact exists (the customers/create webhook usually arrives first, but order
  // events can race or predate the mirror). Create a minimal mirror row if missing.
  const contact = await prisma.contact.upsert({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: gid } },
    update: {},
    create: {
      shop,
      shopifyCustomerId: gid,
      firstName: customer.first_name ?? null,
      lastName: customer.last_name ?? null,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      lastSyncedAt: new Date(),
    },
    select: { id: true, lastOrderAt: true },
  });

  // Atomic idempotency: the unique (shop, orderGid) constraint means only the FIRST delivery of
  // this order proceeds. This closes the orders/create + orders/paid race and the prefix-collision
  // risk of a substring match — duplicate deliveries hit P2002 and no-op (no double-count, no
  // duplicate timeline event).
  try {
    await prisma.processedOrder.create({
      data: { shop, orderGid: oGid, contactId: contact.id },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return; // already processed
    throw error;
  }

  const total = parseMoney(payload.total_price);
  const occurredAt = payload.created_at ? new Date(payload.created_at) : new Date();
  // Keep lastOrderAt monotonic — out-of-order webhook delivery must not regress it.
  const advanceLastOrder = !contact.lastOrderAt || occurredAt > contact.lastOrderAt;

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      ordersCount: { increment: 1 },
      amountSpent: { increment: total },
      ...(advanceLastOrder ? { lastOrderAt: occurredAt } : {}),
      ...(payload.currency ? { currencyCode: payload.currency } : {}),
    },
  });

  await logActivity({
    shop,
    contactId: contact.id,
    type: "ORDER_PLACED",
    occurredAt,
    payload: {
      orderId: oGid,
      orderName: payload.name ?? null,
      total: payload.total_price ?? null,
      currency: payload.currency ?? null,
    },
  });
}

export interface BackfillResult {
  processed: number;
  pages: number;
}

/** One-time (idempotent) backfill of existing customers into the mirror on install. */
export async function backfillContacts(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<BackfillResult> {
  let processed = 0;
  let pages = 0;
  for await (const nodes of iterateCustomers(admin)) {
    pages += 1;
    for (const node of nodes) {
      const amount = node.amountSpent ? parseMoney(node.amountSpent.amount) : 0;
      await prisma.contact.upsert({
        where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: node.id } },
        update: {
          firstName: node.firstName,
          lastName: node.lastName,
          email: node.email,
          phone: node.phone,
          amountSpent: amount,
          ordersCount: toInt(node.numberOfOrders) ?? 0,
          currencyCode: node.amountSpent?.currencyCode ?? null,
          lastSyncedAt: new Date(),
        },
        create: {
          shop,
          shopifyCustomerId: node.id,
          firstName: node.firstName,
          lastName: node.lastName,
          email: node.email,
          phone: node.phone,
          amountSpent: amount,
          ordersCount: toInt(node.numberOfOrders) ?? 0,
          currencyCode: node.amountSpent?.currencyCode ?? null,
          lastSyncedAt: new Date(),
        },
      });
      processed += 1;
    }
  }
  return { processed, pages };
}
