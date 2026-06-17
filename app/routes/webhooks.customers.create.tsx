import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  upsertAndRefreshContact,
  upsertContactFromWebhook,
  type CustomerWebhookPayload,
} from "../lib/crm/mirror.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  const body = payload as CustomerWebhookPayload;
  // Mirror identity, then live-refresh authoritative spend/orders when an admin context is present.
  if (admin) await upsertAndRefreshContact(admin, shop, body);
  else await upsertContactFromWebhook(shop, body);
  return new Response();
};
