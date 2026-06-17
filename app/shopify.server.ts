import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { backfillContacts } from "./lib/crm/mirror.server";

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
      // One-time install backfill: mirror existing Shopify customers when the local mirror is
      // empty for this shop. Guarded so reauthentication doesn't re-run it. For very large
      // catalogs, production should move this to a background job (see DECISIONS.md §8).
      try {
        const existing = await prisma.contact.count({ where: { shop: session.shop } });
        if (existing === 0) {
          const { admin } = await shopify.unauthenticated.admin(session.shop);
          const result = await backfillContacts(admin, session.shop);
          console.log(
            `Backfilled ${result.processed} customers for ${session.shop} (${result.pages} pages).`,
          );
        }
      } catch (error) {
        // Never block install on backfill failure — the manual "Sync from Shopify" action and
        // ongoing customer webhooks will reconcile the mirror.
        console.error(`Customer backfill failed for ${session.shop}:`, error);
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
