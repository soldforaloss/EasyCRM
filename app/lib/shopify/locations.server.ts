/** Shopify location and shop-timezone reads. SERVER ONLY. */

import prisma from "../../db.server";
import type { AdminGraphqlClient } from "./customers.server";

interface GraphqlBody<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function runQuery<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as GraphqlBody<T>;
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((error) => error.message).join("; ")}`);
  }
  if (!body.data) throw new Error("Shopify GraphQL returned no data.");
  return body.data;
}

interface ShopTimezoneData {
  shop: { ianaTimezone: string | null };
}

const SHOP_TIMEZONE_QUERY = `#graphql
  query CrmShopTimezone {
    shop { ianaTimezone }
  }`;

/** Persist Shopify's calendar timezone without overwriting any other settings. */
export async function syncShopTimezone(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<string | null> {
  const data = await runQuery<ShopTimezoneData>(admin, SHOP_TIMEZONE_QUERY);
  await prisma.shopSettings.upsert({
    where: { shop },
    update: { ianaTimezone: data.shop.ianaTimezone },
    create: { shop, ianaTimezone: data.shop.ianaTimezone },
  });
  return data.shop.ianaTimezone;
}

interface LocationNode {
  id: string;
  legacyResourceId: string | number;
  name: string;
  isActive: boolean;
  address: { city: string | null; provinceCode: string | null };
}

interface LocationsPageData {
  locations: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: LocationNode[];
  };
}

const LOCATIONS_PAGE_QUERY = `#graphql
  query CrmLocations($after: String) {
    locations(first: 50, after: $after, includeInactive: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        legacyResourceId
        name
        isActive
        address { city provinceCode }
      }
    }
  }`;

export interface LocationSyncResult {
  processed: number;
  pages: number;
}

/** Mirror active and inactive Shopify locations, keyed by the webhook-compatible legacy id. */
export async function syncLocations(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<LocationSyncResult> {
  await syncShopTimezone(admin, shop);

  let after: string | null = null;
  let processed = 0;
  let pages = 0;
  let hasNextPage = true;
  while (hasNextPage) {
    const data: LocationsPageData = await runQuery<LocationsPageData>(
      admin,
      LOCATIONS_PAGE_QUERY,
      { after },
    );
    pages += 1;
    for (const node of data.locations.nodes) {
      if (!node.id || node.legacyResourceId == null || typeof node.name !== "string") {
        throw new Error("Shopify returned an invalid location node.");
      }
      const legacyId = String(node.legacyResourceId);
      await prisma.location.upsert({
        where: { shop_legacyId: { shop, legacyId } },
        update: {
          shopifyLocationGid: node.id,
          name: node.name,
          isActive: node.isActive,
          city: node.address?.city ?? null,
          provinceCode: node.address?.provinceCode ?? null,
        },
        create: {
          shop,
          shopifyLocationGid: node.id,
          legacyId,
          name: node.name,
          isActive: node.isActive,
          city: node.address?.city ?? null,
          provinceCode: node.address?.provinceCode ?? null,
        },
      });
      processed += 1;
    }
    hasNextPage = data.locations.pageInfo.hasNextPage;
    if (!hasNextPage) break;
    const next = data.locations.pageInfo.endCursor;
    if (!next || next === after) throw new Error("Shopify locations pagination did not advance.");
    after = next;
  }
  return { processed, pages };
}
