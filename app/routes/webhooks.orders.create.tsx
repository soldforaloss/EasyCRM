import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  recordOrderFromWebhook,
  type OrderWebhookPayload,
} from "../lib/crm/mirror.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  await recordOrderFromWebhook(shop, payload as OrderWebhookPayload);
  return new Response();
};
