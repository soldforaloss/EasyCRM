import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  deleteContactFromWebhook,
  type CustomerWebhookPayload,
} from "../lib/crm/mirror.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  await deleteContactFromWebhook(shop, payload as CustomerWebhookPayload);
  return new Response();
};
