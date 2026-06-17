import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  recordOrderAndRefresh,
  recordOrderFromWebhook,
  type OrderWebhookPayload,
} from "../lib/crm/mirror.server";

// orders/paid reuses the same idempotent recorder; if orders/create already logged this order,
// the (shop, orderGid) dedup lock makes the timeline part a no-op while the refresh keeps the
// cached spend authoritative.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  const body = payload as OrderWebhookPayload;
  if (admin) await recordOrderAndRefresh(admin, shop, body);
  else await recordOrderFromWebhook(shop, body);
  return new Response();
};
