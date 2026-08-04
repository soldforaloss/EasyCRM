import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { enqueueJob } from "./lib/jobs/queue.server";
import { logger, reportError } from "./lib/logger.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // App-specific webhooks (including the mandatory compliance topics) are declared in
      // shopify.app.toml, so no manual registration is needed here.
      //
      // One-time install backfill. This ENQUEUES rather than running inline: a shop with tens of
      // thousands of customers would otherwise hold the OAuth callback open until the platform
      // timed it out, failing the install. The dedupe key makes re-authentication a no-op.
      // See DECISIONS.md §11.
      try {
        const existing = await prisma.contact.count({ where: { shop: session.shop } });
        if (existing === 0) {
          const job = await enqueueJob({
            shop: session.shop,
            type: "BACKFILL_CUSTOMERS",
            payload: {},
            dedupeKey: "backfill:initial",
            maxAttempts: 5,
          });
          logger.info("install.backfill_enqueued", {
            shop: session.shop,
            enqueued: Boolean(job),
          });
        }
      } catch (error) {
        // Never block install on this — the manual "Sync from Shopify" action and the ongoing
        // customer webhooks will reconcile the mirror either way.
        void reportError("install.backfill_enqueue_failed", error, { shop: session.shop });
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
