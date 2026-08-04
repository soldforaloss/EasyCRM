import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  customerGidFromCompliancePayload,
  recordDataRequest,
  redactCustomer,
  redactShop,
  type CompliancePayload,
} from "../lib/crm/compliance.server";
import { logger } from "../lib/logger.server";

/**
 * Single endpoint for the three mandatory privacy/compliance topics (declared via
 * `compliance_topics` in shopify.app.toml). Shopify HMAC-verifies the request through
 * `authenticate.webhook`; we switch on the topic to take the right action.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as CompliancePayload;
  logger.info("compliance.received", { shop, topic });

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const gid = customerGidFromCompliancePayload(body);
      if (gid) {
        // Persist the export so the merchant can actually deliver it — Shopify offers no
        // callback for data requests. Surfaced at /app/privacy. See DECISIONS.md §14.
        const id = await recordDataRequest(shop, gid, body.customer?.email ?? null);
        logger.info("compliance.data_request_stored", { shop, customerGid: gid, requestId: id });
      }
      return new Response();
    }
    case "CUSTOMERS_REDACT": {
      const gid = customerGidFromCompliancePayload(body);
      if (gid) {
        await redactCustomer(shop, gid);
        logger.info("compliance.customer_redacted", { shop, customerGid: gid });
      }
      return new Response();
    }
    case "SHOP_REDACT": {
      await redactShop(shop);
      logger.info("compliance.shop_redacted", { shop });
      return new Response();
    }
    default:
      // Unknown compliance topic — acknowledge so Shopify does not retry.
      return new Response();
  }
};
