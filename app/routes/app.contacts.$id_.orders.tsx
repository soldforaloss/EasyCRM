import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getContact } from "../lib/crm/contacts.server";
import { fetchCustomerOrders } from "../lib/shopify/customers.server";

/**
 * Resource route: returns one page of a customer's live Shopify orders (JSON) for the detail
 * page's "Load more" pagination, without re-running the full detail loader. The trailing
 * underscore on `$id_` opts this route out of nesting under the detail layout.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const contact = await getContact(shop, params.id ?? "");
  if (!contact) {
    return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  try {
    const result = await fetchCustomerOrders(admin, contact.shopifyCustomerId, {
      orders: 10,
      ordersAfter: after,
    });
    return {
      orders: result?.orders.nodes ?? [],
      pageInfo: result?.orders.pageInfo ?? { hasNextPage: false, endCursor: null },
    };
  } catch {
    return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }
};
