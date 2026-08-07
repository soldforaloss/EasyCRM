/**
 * Maintains the local Contact mirror from Shopify webhooks + install backfill. SERVER ONLY.
 * All handlers are idempotent (upsert / dedupe) so duplicate webhook deliveries are safe
 * (see DECISIONS.md / brief §3).
 */

import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { parseMoney } from "../format";
import { dateStringInTz } from "../timezone";
import {
  fetchCustomerSyncFields,
  iterateCustomers,
  type AdminGraphqlClient,
} from "../shopify/customers.server";
import { iterateRecentOrders } from "../shopify/orders.server";
import { recomputeDerivedPreferences } from "./preferences.server";

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
  location_id?: number | string | null;
  source_name?: string | null;
  user_id?: number | string | null;
  device_id?: number | string | null;
  line_items?: OrderWebhookLineItem[] | null;
  customer?: CustomerWebhookPayload | null;
}

export interface OrderWebhookLineItem {
  title?: string | null;
  quantity?: number | string | null;
  variant_title?: string | null;
  sku?: string | null;
  product_id?: number | string | null;
  price?: string | null;
}

export interface StoredOrderLineItem {
  title: string;
  quantity: number;
  variantTitle: string | null;
  sku: string | null;
  productId: string | null;
}

export interface LocalOrderInput {
  shop: string;
  orderGid: string;
  contactId: string;
  orderName: string | null;
  total: string | null;
  currencyCode: string | null;
  occurredAt: Date | null;
  sourceName: string | null;
  locationId: string | null;
  posUserId: string | null;
  posDeviceId: string | null;
  lineItems: StoredOrderLineItem[] | null;
}

export type OrderRecordResult = "created" | "enriched" | "duplicate" | "skipped";

function customerGid(p: CustomerWebhookPayload): string | null {
  if (p.admin_graphql_api_id) return p.admin_graphql_api_id;
  if (p.id != null) return `gid://shopify/Customer/${p.id}`;
  return null;
}

function orderGid(p: OrderWebhookPayload): string | null {
  if (p.admin_graphql_api_id) return p.admin_graphql_api_id;
  if (p.id != null) return `gid://shopify/Order/${p.id}`;
  return null;
}

function toInt(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function toOptionalString(value: number | string | null | undefined): string | null {
  return value == null ? null : String(value);
}

function toOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeWebhookLineItems(
  items: OrderWebhookLineItem[] | null | undefined,
): StoredOrderLineItem[] | null {
  if (!Array.isArray(items)) return null;
  return items.flatMap((item) => {
    const quantity = toInt(item.quantity);
    if (typeof item.title !== "string" || quantity === undefined) return [];
    return [
      {
        title: item.title,
        quantity,
        variantTitle: typeof item.variant_title === "string" ? item.variant_title : null,
        sku: typeof item.sku === "string" ? item.sku : null,
        productId: toOptionalString(item.product_id),
      },
    ];
  });
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

interface RecordLocalOrderOptions {
  /** Backfill may fill columns that were null on a pre-Phase-2 webhook row. */
  enrichExisting?: boolean;
  /** Webhooks also maintain the optimistic contact cache and append one timeline activity. */
  applyWebhookEffects?: boolean;
}

function processedOrderData(input: LocalOrderInput) {
  return {
    shop: input.shop,
    orderGid: input.orderGid,
    contactId: input.contactId,
    orderName: input.orderName,
    total: input.total,
    currencyCode: input.currencyCode,
    occurredAt: input.occurredAt,
    sourceName: input.sourceName,
    locationId: input.locationId,
    posUserId: input.posUserId,
    posDeviceId: input.posDeviceId,
    lineItems: input.lineItems === null ? null : JSON.stringify(input.lineItems),
  };
}

async function resolveVisitDate(input: LocalOrderInput): Promise<string | null> {
  if (input.sourceName !== "pos" || !input.locationId || !input.occurredAt) return null;
  const settings = await prisma.shopSettings.findUnique({
    where: { shop: input.shop },
    select: { ianaTimezone: true },
  });
  return dateStringInTz(input.occurredAt, settings?.ianaTimezone ?? null);
}

async function recordPosVisit(
  tx: Prisma.TransactionClient,
  input: LocalOrderInput,
  visitDate: string,
): Promise<void> {
  const locationId = input.locationId;
  const occurredAt = input.occurredAt;
  if (!locationId || !occurredAt) return;

  await tx.visit.upsert({
    where: {
      shop_contactId_locationId_visitDate: {
        shop: input.shop,
        contactId: input.contactId,
        locationId,
        visitDate,
      },
    },
    update: {},
    create: {
      shop: input.shop,
      contactId: input.contactId,
      locationId,
      visitDate,
      source: "POS_ORDER",
      orderGid: input.orderGid,
    },
  });

  await tx.contactLocation.upsert({
    where: { contactId_locationId: { contactId: input.contactId, locationId } },
    update: { ordersCount: { increment: 1 } },
    create: {
      shop: input.shop,
      contactId: input.contactId,
      locationId,
      ordersCount: 1,
      lastOrderAt: occurredAt,
    },
  });
  await tx.contactLocation.updateMany({
    where: {
      contactId: input.contactId,
      locationId,
      OR: [{ lastOrderAt: null }, { lastOrderAt: { lt: occurredAt } }],
    },
    data: { lastOrderAt: occurredAt },
  });

  await tx.contact.updateMany({
    where: {
      id: input.contactId,
      OR: [{ lastVisitAt: null }, { lastVisitAt: { lt: occurredAt } }],
    },
    data: { lastVisitAt: occurredAt, lastVisitLocationId: locationId },
  });
}

async function applyWebhookOrderEffects(
  tx: Prisma.TransactionClient,
  input: LocalOrderInput,
): Promise<void> {
  await tx.contact.update({
    where: { id: input.contactId },
    data: {
      ordersCount: { increment: 1 },
      amountSpent: { increment: parseMoney(input.total) },
      ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}),
    },
  });
  if (!input.occurredAt) return;

  await tx.contact.updateMany({
    where: {
      id: input.contactId,
      OR: [{ lastOrderAt: null }, { lastOrderAt: { lt: input.occurredAt } }],
    },
    data: { lastOrderAt: input.occurredAt },
  });
  await tx.activity.create({
    data: {
      shop: input.shop,
      contactId: input.contactId,
      type: "ORDER_PLACED",
      occurredAt: input.occurredAt,
      payload: JSON.stringify({
        orderId: input.orderGid,
        orderName: input.orderName,
        total: input.total,
        currency: input.currencyCode,
      }),
    },
  });
}

async function enrichExistingOrder(
  input: LocalOrderInput,
  visitDate: string | null,
): Promise<OrderRecordResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.processedOrder.findUnique({
      where: { shop_orderGid: { shop: input.shop, orderGid: input.orderGid } },
      select: {
        id: true,
        orderName: true,
        total: true,
        currencyCode: true,
        occurredAt: true,
        sourceName: true,
        locationId: true,
        posUserId: true,
        posDeviceId: true,
        lineItems: true,
      },
    });
    if (!existing) throw new Error(`Processed order disappeared: ${input.orderGid}`);

    const incoming = processedOrderData(input);
    const update: Prisma.ProcessedOrderUpdateManyMutationInput = {};
    if (existing.orderName === null && incoming.orderName !== null) update.orderName = incoming.orderName;
    if (existing.total === null && incoming.total !== null) update.total = incoming.total;
    if (existing.currencyCode === null && incoming.currencyCode !== null) {
      update.currencyCode = incoming.currencyCode;
    }
    if (existing.occurredAt === null && incoming.occurredAt !== null) {
      update.occurredAt = incoming.occurredAt;
    }
    if (existing.sourceName === null && incoming.sourceName !== null) {
      update.sourceName = incoming.sourceName;
    }
    if (existing.locationId === null && incoming.locationId !== null) {
      update.locationId = incoming.locationId;
    }
    if (existing.posUserId === null && incoming.posUserId !== null) {
      update.posUserId = incoming.posUserId;
    }
    if (existing.posDeviceId === null && incoming.posDeviceId !== null) {
      update.posDeviceId = incoming.posDeviceId;
    }
    if (existing.lineItems === null && incoming.lineItems !== null) {
      update.lineItems = incoming.lineItems;
    }
    if (Object.keys(update).length === 0) return "duplicate";

    const addVisit = Boolean(visitDate && existing.locationId === null && input.locationId);
    const updated = await tx.processedOrder.updateMany({
      where: { id: existing.id, ...(addVisit ? { locationId: null } : {}) },
      data: update,
    });
    if (updated.count !== 1) return "duplicate";
    if (addVisit && visitDate) await recordPosVisit(tx, input, visitDate);
    if (
      existing.lineItems === null &&
      incoming.lineItems !== null &&
      (input.lineItems?.length ?? 0) > 0
    ) {
      await recomputeDerivedPreferences(input.shop, input.contactId, tx);
    }
    return "enriched";
  });
}

/**
 * The single persistence choke point for a local order record plus optional POS visit/rollup.
 * Webhook duplicates no-op; backfill may fill only columns that are still null on legacy rows.
 */
export async function recordOrderWithVisit(
  input: LocalOrderInput,
  options: RecordLocalOrderOptions = {},
): Promise<OrderRecordResult> {
  const visitDate = await resolveVisitDate(input);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.processedOrder.create({ data: processedOrderData(input) });
      if (visitDate) await recordPosVisit(tx, input, visitDate);
      if (options.applyWebhookEffects) await applyWebhookOrderEffects(tx, input);
      if ((input.lineItems?.length ?? 0) > 0) {
        await recomputeDerivedPreferences(input.shop, input.contactId, tx);
      }
      return "created" as const;
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    if (!options.enrichExisting) return "duplicate";
    return enrichExistingOrder(input, visitDate);
  }
}

/** Capture one customer-attributed order webhook. Guest orders remain intentionally invisible. */
export async function recordOrderFromWebhook(
  shop: string,
  payload: OrderWebhookPayload,
): Promise<OrderRecordResult> {
  const customer = payload.customer;
  if (!customer) return "skipped";
  const gid = customerGid(customer);
  const oGid = orderGid(payload);
  if (!gid || !oGid) return "skipped";

  // Customer webhooks can race an order, so establish the minimal contact row before the order FK.
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
    select: { id: true },
  });

  return recordOrderWithVisit(
    {
      shop,
      orderGid: oGid,
      contactId: contact.id,
      orderName: payload.name ?? null,
      total: payload.total_price ?? null,
      currencyCode: payload.currency ?? null,
      occurredAt: toOptionalDate(payload.created_at),
      sourceName: payload.source_name ?? null,
      locationId: toOptionalString(payload.location_id),
      posUserId: toOptionalString(payload.user_id),
      posDeviceId: toOptionalString(payload.device_id),
      lineItems: normalizeWebhookLineItems(payload.line_items),
    },
    { applyWebhookEffects: true },
  );
}

/**
 * Live per-customer refresh: pull authoritative spend / order count / last-order date from the
 * GraphQL Admin API and write them to the mirror (absolute, the source of truth). Called by the
 * customers/* and orders/* webhook handlers so the list stays correct after refunds, edits and
 * cancellations (Shopify no longer ships these fields in the webhook payload). Never throws — a
 * refresh failure (e.g. transient rate-limit) leaves the optimistic values in place and is
 * reconciled by the next webhook or backfill.
 */
export async function refreshContactFromShopify(
  admin: AdminGraphqlClient,
  shop: string,
  customerGid: string,
): Promise<void> {
  let fields;
  try {
    fields = await fetchCustomerSyncFields(admin, customerGid);
  } catch {
    return;
  }
  if (!fields) return;
  await prisma.contact.updateMany({
    where: { shop, shopifyCustomerId: customerGid },
    data: {
      amountSpent: fields.amountSpent,
      ordersCount: fields.numberOfOrders,
      ...(fields.currencyCode ? { currencyCode: fields.currencyCode } : {}),
      ...(fields.lastOrderAt ? { lastOrderAt: new Date(fields.lastOrderAt) } : {}),
      lastSyncedAt: new Date(),
    },
  });
}

/** customers/create|update: mirror identity fields, then live-refresh authoritative spend/orders. */
export async function upsertAndRefreshContact(
  admin: AdminGraphqlClient,
  shop: string,
  payload: CustomerWebhookPayload,
): Promise<void> {
  await upsertContactFromWebhook(shop, payload);
  const gid = customerGid(payload);
  if (gid) await refreshContactFromShopify(admin, shop, gid);
}

/** orders/create|paid: append the timeline event, then live-refresh authoritative spend/orders. */
export async function recordOrderAndRefresh(
  admin: AdminGraphqlClient,
  shop: string,
  payload: OrderWebhookPayload,
): Promise<void> {
  const result = await recordOrderFromWebhook(shop, payload);
  if (result !== "created") return;
  const gid = payload.customer ? customerGid(payload.customer) : null;
  if (gid) await refreshContactFromShopify(admin, shop, gid);
}

export interface BackfillResult {
  processed: number;
  pages: number;
}

export interface OrderBackfillResult extends BackfillResult {
  created: number;
  enriched: number;
  duplicates: number;
}

/** Backfill the standard Shopify 60-day order window through the shared order/visit choke point. */
export async function backfillOrders(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<OrderBackfillResult> {
  let processed = 0;
  let pages = 0;
  let created = 0;
  let enriched = 0;
  let duplicates = 0;

  for await (const nodes of iterateRecentOrders(admin)) {
    pages += 1;
    for (const node of nodes) {
      if (!node.customer) continue;
      const occurredAt = new Date(node.createdAt);
      if (!node.id || Number.isNaN(occurredAt.getTime())) {
        throw new Error("Shopify returned an invalid order node.");
      }

      const contact = await prisma.contact.upsert({
        where: {
          shop_shopifyCustomerId: { shop, shopifyCustomerId: node.customer.id },
        },
        update: {},
        create: {
          shop,
          shopifyCustomerId: node.customer.id,
          lastSyncedAt: new Date(),
        },
        select: { id: true },
      });
      const money = node.totalPriceSet?.shopMoney ?? null;
      const result = await recordOrderWithVisit(
        {
          shop,
          orderGid: node.id,
          contactId: contact.id,
          orderName: node.name ?? null,
          total: money?.amount ?? null,
          currencyCode: money?.currencyCode ?? null,
          occurredAt,
          sourceName: node.sourceName ?? null,
          locationId:
            node.retailLocation?.legacyResourceId == null
              ? null
              : String(node.retailLocation.legacyResourceId),
          posUserId: null,
          posDeviceId: null,
          lineItems: node.lineItems.nodes.map((item) => ({
            title: item.title,
            quantity: item.quantity,
            variantTitle: item.variantTitle ?? null,
            sku: item.sku ?? null,
            // `LineItem.product` would require read_products; webhook product_id remains richer.
            productId: null,
          })),
        },
        { enrichExisting: true },
      );
      processed += 1;
      if (result === "created") created += 1;
      else if (result === "enriched") enriched += 1;
      else duplicates += 1;
    }
  }
  return { processed, pages, created, enriched, duplicates };
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
