import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  recordOrderFromWebhook,
  type OrderWebhookPayload,
} from "../lib/crm/mirror.server";

// orders/paid reuses the same idempotent recorder; if orders/create already logged this order,
// the dedupe guard in recordOrderFromWebhook makes this a no-op.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  await recordOrderFromWebhook(shop, payload as OrderWebhookPayload);
  return new Response();
};
