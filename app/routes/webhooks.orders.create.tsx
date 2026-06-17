import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  recordOrderAndRefresh,
  recordOrderFromWebhook,
  type OrderWebhookPayload,
} from "../lib/crm/mirror.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  const body = payload as OrderWebhookPayload;
  // Append the ORDER_PLACED timeline event, then live-refresh authoritative spend/orders.
  if (admin) await recordOrderAndRefresh(admin, shop, body);
  else await recordOrderFromWebhook(shop, body);
  return new Response();
};
