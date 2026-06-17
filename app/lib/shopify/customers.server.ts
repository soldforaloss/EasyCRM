/**
 * Live Shopify customer reads via the GraphQL Admin API. SERVER ONLY.
 *
 * Used for: (a) on-install/backfill mirroring of existing customers, and (b) the detail page's
 * authoritative live profile + order history. The local mirror is never the source of truth for
 * these — see DECISIONS.md §3. Order history is limited to the trailing 60 days unless the shop
 * has `read_all_orders` (which this app intentionally does not request — DECISIONS.md §4).
 */

/** Minimal structural type for the authenticated admin GraphQL client from the template. */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

interface GraphqlBody<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function runQuery<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await res.json()) as GraphqlBody<T>;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("Shopify GraphQL returned no data.");
  return body.data;
}

/* ------------------------------------------------------------------ */
/* Backfill: iterate every customer                                    */
/* ------------------------------------------------------------------ */

export interface MirrorCustomerNode {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  numberOfOrders: string; // GraphQL returns UnsignedInt64 as string
  amountSpent: { amount: string; currencyCode: string } | null;
  createdAt: string;
}

interface CustomersPageData {
  customers: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: MirrorCustomerNode[];
  };
}

const CUSTOMERS_PAGE_QUERY = `#graphql
  query CrmBackfillCustomers($first: Int!, $after: String) {
    customers(first: $first, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        firstName
        lastName
        email
        phone
        numberOfOrders
        amountSpent { amount currencyCode }
        createdAt
      }
    }
  }`;

/** Async generator yielding pages of customers for backfill. */
export async function* iterateCustomers(
  admin: AdminGraphqlClient,
  pageSize = 100,
): AsyncGenerator<MirrorCustomerNode[]> {
  let after: string | null = null;
  // Hard cap on pages as a runaway guard (100 pages * 100 = 10k customers per backfill run).
  for (let page = 0; page < 100; page += 1) {
    const data: CustomersPageData = await runQuery<CustomersPageData>(
      admin,
      CUSTOMERS_PAGE_QUERY,
      { first: pageSize, after },
    );
    yield data.customers.nodes;
    if (!data.customers.pageInfo.hasNextPage) break;
    after = data.customers.pageInfo.endCursor;
    if (!after) break;
  }
}

/* ------------------------------------------------------------------ */
/* Detail page: live profile + order history                          */
/* ------------------------------------------------------------------ */

export interface LiveLineItem {
  title: string;
  quantity: number;
}

export interface LiveCustomerOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  lineItems: LiveLineItem[];
}

export interface LiveCustomer {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  verifiedEmail: boolean | null;
  createdAt: string;
  updatedAt: string;
  numberOfOrders: string;
  amountSpent: { amount: string; currencyCode: string } | null;
  emailMarketingState: string | null;
  smsMarketingState: string | null;
  defaultAddress: LiveAddress | null;
  tags: string[];
  /** ISO date of the customer's earliest order (for tenure / order frequency). */
  firstOrderAt: string | null;
  /** ISO date of the customer's most recent order. */
  lastOrderAt: string | null;
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: LiveCustomerOrder[];
  };
}

export interface LiveAddress {
  formatted?: string[] | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  zip: string | null;
  phone: string | null;
}

interface CustomerDetailData {
  customer:
    | {
        id: string;
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
        note: string | null;
        verifiedEmail: boolean | null;
        createdAt: string;
        updatedAt: string;
        numberOfOrders: string;
        amountSpent: { amount: string; currencyCode: string } | null;
        defaultEmailAddress: { emailAddress: string | null; marketingState: string | null } | null;
        defaultPhoneNumber: { phoneNumber: string | null; marketingState: string | null } | null;
        defaultAddress: LiveAddress | null;
        tags: string[];
        firstOrder: { nodes: Array<{ createdAt: string }> };
        lastOrder: { createdAt: string } | null;
        orders: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<Omit<LiveCustomerOrder, "lineItems"> & {
            lineItems: { nodes: LiveLineItem[] };
          }>;
        };
      }
    | null;
}

const CUSTOMER_DETAIL_QUERY = `#graphql
  query CrmCustomerDetail($id: ID!, $orders: Int!, $ordersAfter: String) {
    customer(id: $id) {
      id
      displayName
      firstName
      lastName
      note
      verifiedEmail
      createdAt
      updatedAt
      numberOfOrders
      amountSpent { amount currencyCode }
      defaultEmailAddress { emailAddress marketingState }
      defaultPhoneNumber { phoneNumber marketingState }
      tags
      defaultAddress {
        formatted
        address1
        address2
        city
        province
        country
        zip
        phone
      }
      firstOrder: orders(first: 1, sortKey: CREATED_AT) {
        nodes { createdAt }
      }
      lastOrder { createdAt }
      orders(first: $orders, after: $ordersAfter, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 10) { nodes { title quantity } }
        }
      }
    }
  }`;

export async function fetchCustomerDetail(
  admin: AdminGraphqlClient,
  customerGid: string,
  opts: { orders?: number; ordersAfter?: string | null } = {},
): Promise<LiveCustomer | null> {
  const data = await runQuery<CustomerDetailData>(admin, CUSTOMER_DETAIL_QUERY, {
    id: customerGid,
    orders: opts.orders ?? 10,
    ordersAfter: opts.ordersAfter ?? null,
  });
  if (!data.customer) return null;
  const c = data.customer;
  return {
    id: c.id,
    displayName: c.displayName,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.defaultEmailAddress?.emailAddress ?? null,
    phone: c.defaultPhoneNumber?.phoneNumber ?? null,
    note: c.note,
    verifiedEmail: c.verifiedEmail,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    numberOfOrders: c.numberOfOrders,
    amountSpent: c.amountSpent,
    emailMarketingState: c.defaultEmailAddress?.marketingState ?? null,
    smsMarketingState: c.defaultPhoneNumber?.marketingState ?? null,
    defaultAddress: c.defaultAddress,
    tags: c.tags ?? [],
    firstOrderAt: c.firstOrder?.nodes[0]?.createdAt ?? null,
    lastOrderAt: c.lastOrder?.createdAt ?? null,
    orders: {
      pageInfo: c.orders.pageInfo,
      nodes: c.orders.nodes.map((o) => ({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        displayFinancialStatus: o.displayFinancialStatus,
        displayFulfillmentStatus: o.displayFulfillmentStatus,
        totalPriceSet: o.totalPriceSet,
        lineItems: o.lineItems?.nodes ?? [],
      })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lightweight sync fields (live per-customer refresh on webhook)      */
/* ------------------------------------------------------------------ */

export interface CustomerSyncFields {
  amountSpent: number;
  currencyCode: string | null;
  numberOfOrders: number;
  lastOrderAt: string | null;
}

interface CustomerSyncData {
  customer: {
    numberOfOrders: string;
    amountSpent: { amount: string; currencyCode: string } | null;
    lastOrder: { createdAt: string } | null;
  } | null;
}

const CUSTOMER_SYNC_QUERY = `#graphql
  query CrmCustomerSync($id: ID!) {
    customer(id: $id) {
      numberOfOrders
      amountSpent { amount currencyCode }
      lastOrder { createdAt }
    }
  }`;

/** Fetch authoritative spend/orders/last-order for one customer (used by the webhook refresh). */
export async function fetchCustomerSyncFields(
  admin: AdminGraphqlClient,
  customerGid: string,
): Promise<CustomerSyncFields | null> {
  const data = await runQuery<CustomerSyncData>(admin, CUSTOMER_SYNC_QUERY, {
    id: customerGid,
  });
  if (!data.customer) return null;
  const amount = data.customer.amountSpent?.amount;
  return {
    amountSpent: amount ? Number.parseFloat(amount) : 0,
    currencyCode: data.customer.amountSpent?.currencyCode ?? null,
    numberOfOrders: Number.parseInt(data.customer.numberOfOrders, 10) || 0,
    lastOrderAt: data.customer.lastOrder?.createdAt ?? null,
  };
}

interface CustomerOrdersData {
  customer: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<Omit<LiveCustomerOrder, "lineItems"> & {
        lineItems: { nodes: LiveLineItem[] };
      }>;
    };
  } | null;
}

export interface OrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: LiveCustomerOrder[];
  };
}

const CUSTOMER_ORDERS_QUERY = `#graphql
  query CrmCustomerOrders($id: ID!, $orders: Int!, $ordersAfter: String) {
    customer(id: $id) {
      orders(first: $orders, after: $ordersAfter, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 10) { nodes { title quantity } }
        }
      }
    }
  }`;

export async function fetchCustomerOrders(
  admin: AdminGraphqlClient,
  customerGid: string,
  opts: { orders?: number; ordersAfter?: string | null } = {},
): Promise<OrdersPage | null> {
  const data = await runQuery<CustomerOrdersData>(admin, CUSTOMER_ORDERS_QUERY, {
    id: customerGid,
    orders: opts.orders ?? 10,
    ordersAfter: opts.ordersAfter ?? null,
  });
  if (!data.customer) return null;
  return {
    orders: {
      pageInfo: data.customer.orders.pageInfo,
      nodes: data.customer.orders.nodes.map((o) => ({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        displayFinancialStatus: o.displayFinancialStatus,
        displayFulfillmentStatus: o.displayFulfillmentStatus,
        totalPriceSet: o.totalPriceSet,
        lineItems: o.lineItems?.nodes ?? [],
      })),
    },
  };
}
