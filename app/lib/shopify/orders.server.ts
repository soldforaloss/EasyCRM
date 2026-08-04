/** Last-60-days Shopify order reads for the local order/visit backfill. SERVER ONLY. */

import type { AdminGraphqlClient } from "./customers.server";

interface GraphqlBody<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function runQuery<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as GraphqlBody<T>;
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((error) => error.message).join("; ")}`);
  }
  if (!body.data) throw new Error("Shopify GraphQL returned no data.");
  return body.data;
}

export interface BackfillOrderNode {
  id: string;
  name: string;
  createdAt: string;
  sourceName: string | null;
  totalPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  retailLocation: { legacyResourceId: string | number; name: string } | null;
  customer: { id: string } | null;
  lineItems: {
    nodes: Array<{
      title: string;
      quantity: number;
      variantTitle: string | null;
      sku: string | null;
    }>;
  };
}

interface OrdersPageData {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: BackfillOrderNode[];
  };
}

const ORDERS_PAGE_QUERY = `#graphql
  query CrmBackfillOrders($after: String, $query: String!) {
    orders(first: 50, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        sourceName
        totalPriceSet { shopMoney { amount currencyCode } }
        retailLocation { legacyResourceId name }
        customer { id }
        lineItems(first: 50) {
          nodes { title quantity variantTitle sku }
        }
      }
    }
  }`;

/** Yield every page Shopify exposes within the standard trailing 60-day order window. */
export async function* iterateRecentOrders(
  admin: AdminGraphqlClient,
  now = new Date(),
): AsyncGenerator<BackfillOrderNode[]> {
  const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const query = `created_at:>='${cutoff.toISOString()}'`;
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: OrdersPageData = await runQuery<OrdersPageData>(admin, ORDERS_PAGE_QUERY, {
      after,
      query,
    });
    yield data.orders.nodes;
    hasNextPage = data.orders.pageInfo.hasNextPage;
    if (!hasNextPage) break;
    const next = data.orders.pageInfo.endCursor;
    if (!next || next === after) throw new Error("Shopify orders pagination did not advance.");
    after = next;
  }
}
