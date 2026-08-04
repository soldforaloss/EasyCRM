import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  recordOrderAndRefresh,
  recordOrderFromWebhook,
  type OrderWebhookPayload,
} from "../lib/crm/mirror.server";

// orders/paid reuses the same idempotent recorder. If orders/create already captured the order,
// the (shop, orderGid) dedup lock makes the entire duplicate delivery a no-op.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  const body = payload as OrderWebhookPayload;
  if (admin) await recordOrderAndRefresh(admin, shop, body);
  else await recordOrderFromWebhook(shop, body);
  return new Response();
};
