import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  assembleCustomerData,
  customerGidFromCompliancePayload,
  redactCustomer,
  redactShop,
  type CompliancePayload,
} from "../lib/crm/compliance.server";

/**
 * Single endpoint for the three mandatory privacy/compliance topics (declared via
 * `compliance_topics` in shopify.app.toml). Shopify HMAC-verifies the request through
 * `authenticate.webhook`; we switch on the topic to take the right action.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as CompliancePayload;
  console.log(`Received compliance webhook ${topic} for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const gid = customerGidFromCompliancePayload(body);
      if (gid) {
        const data = await assembleCustomerData(shop, gid);
        // No Shopify callback exists for data requests — the merchant must deliver this to the
        // customer. We assemble it here; production should email/store it for the merchant.
        console.log(
          `[compliance] data_request for ${gid} on ${shop}: ${data.found ? "data assembled" : "no CRM data stored"}`,
        );
      }
      return new Response();
    }
    case "CUSTOMERS_REDACT": {
      const gid = customerGidFromCompliancePayload(body);
      if (gid) await redactCustomer(shop, gid);
      return new Response();
    }
    case "SHOP_REDACT": {
      await redactShop(shop);
      return new Response();
    }
    default:
      // Unknown compliance topic — acknowledge so Shopify does not retry.
      return new Response();
  }
};
