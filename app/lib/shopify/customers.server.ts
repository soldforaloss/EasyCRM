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

export interface LiveCustomerOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
}

export interface LiveCustomer {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  numberOfOrders: string;
  amountSpent: { amount: string; currencyCode: string } | null;
  emailMarketingState: string | null;
  smsMarketingState: string | null;
  defaultAddress: LiveAddress | null;
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
  customer: (Omit<LiveCustomer, "emailMarketingState" | "smsMarketingState"> & {
    emailMarketingConsent: { marketingState: string } | null;
    smsMarketingConsent: { marketingState: string } | null;
  }) | null;
}

const CUSTOMER_DETAIL_QUERY = `#graphql
  query CrmCustomerDetail($id: ID!, $orders: Int!, $ordersAfter: String) {
    customer(id: $id) {
      id
      displayName
      firstName
      lastName
      email
      phone
      note
      createdAt
      updatedAt
      numberOfOrders
      amountSpent { amount currencyCode }
      emailMarketingConsent { marketingState }
      smsMarketingConsent { marketingState }
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
      orders(first: $orders, after: $ordersAfter, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
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
    email: c.email,
    phone: c.phone,
    note: c.note,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    numberOfOrders: c.numberOfOrders,
    amountSpent: c.amountSpent,
    emailMarketingState: c.emailMarketingConsent?.marketingState ?? null,
    smsMarketingState: c.smsMarketingConsent?.marketingState ?? null,
    defaultAddress: c.defaultAddress,
    orders: c.orders,
  };
}

interface CustomerOrdersData {
  customer: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LiveCustomerOrder[];
    };
  } | null;
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
        }
      }
    }
  }`;

export async function fetchCustomerOrders(
  admin: AdminGraphqlClient,
  customerGid: string,
  opts: { orders?: number; ordersAfter?: string | null } = {},
): Promise<CustomerOrdersData["customer"]> {
  const data = await runQuery<CustomerOrdersData>(admin, CUSTOMER_ORDERS_QUERY, {
    id: customerGid,
    orders: opts.orders ?? 10,
    ordersAfter: opts.ordersAfter ?? null,
  });
  return data.customer;
}
