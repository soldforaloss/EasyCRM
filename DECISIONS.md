# DECISIONS — Easy CRM (embedded Shopify CRM + Brevo BYOK messaging)

This file records the scaffold facts discovered up front and every non-obvious assumption
made while building. Read it before changing foundational config.

## 0. Scaffold facts (verified by inspection, not assumed)

| Aspect | What the scaffold actually ships |
| --- | --- |
| Template | `@shopify/shopify-app-react-router@^1.1.0` (the current **React Router v7** app template — Remix is in maintenance mode) |
| Router | React Router `^7.12.0`, file-system routes via `@react-router/fs-routes` `flatRoutes()` |
| UI | **Polaris web components** (`<s-*>` custom elements) — confirmed by `app/routes/app._index.tsx` ("Interface: Polaris web components") and `tsconfig` `types: ["@shopify/polaris-types"]`. **No `@shopify/polaris` React package is installed.** |
| App Bridge | `@shopify/app-bridge-react@^4` via `AppProvider` from `@shopify/shopify-app-react-router/react`; nav via `<s-app-nav>` + `<s-link>` |
| Auth | `authenticate.admin(request)` / `authenticate.webhook(request)` from `app/shopify.server.ts` |
| DB | Prisma `^6.16.3`, datasource **SQLite** (`prisma/dev.sqlite`), session storage via `@shopify/shopify-app-session-storage-prisma` |
| Data access | GraphQL Admin API via `admin.graphql(...)` |
| TypeScript | strict mode already on (`tsconfig.json`) |

## 1. API version — standardized on `2026-04` (April26)

**Problem found:** the scaffold is internally inconsistent about the Admin API version:
- `app/shopify.server.ts` and `.graphqlrc.ts` pin `ApiVersion.October25` (`2025-10`).
- `shopify.app.toml` `[webhooks] api_version = "2026-07"`.
- The installed `@shopify/shopify-api` `ApiVersion` enum **tops out at `April26 = "2026-04"`** —
  there is no `July26` member, so `2026-07` is ahead of what the SDK supports.

**Decision:** standardize **everything** on `ApiVersion.April26` (`"2026-04"`), the latest the
installed SDK supports, for a coherent client + webhook payload contract:
- `app/shopify.server.ts` → `apiVersion: ApiVersion.April26`
- `.graphqlrc.ts` → `apiVersion: ApiVersion.April26` (so codegen, if run, matches)
- `shopify.app.toml` → `[webhooks] api_version = "2026-04"`

When the SDK is upgraded to expose a newer stable version, bump all three together.

## 2. Prisma portability — SQLite dev, Postgres/MySQL prod

The dev datasource stays SQLite (scaffold default). To keep the **same schema** working on
dev SQLite *and* production Postgres/MySQL by swapping only `DATABASE_URL` + `provider`:

- **No native Prisma `enum` types.** SQLite does not support them. Every "enum" field is a
  `String` with an app-level TypeScript union + validation in `app/lib/crm/constants.ts`.
  (Allowed values are documented next to each field.)
- **JSON stored as `String`.** `Activity.payload` and `Segment.criteria` hold
  `JSON.stringify(...)` text, parsed via typed helpers. Avoids SQLite `Json` edge cases and
  is identical across all three databases.
- **Money stored as `String`** (decimal string, e.g. `"123.45"`) + a `currencyCode`. No
  `Decimal`/`Float` for money — avoids precision loss and SQLite `Decimal` nuance.
- **No connector-specific native type attributes** (`@db.Text`, `@db.LongText`). With the
  SQLite provider active, Prisma rejects them. **Caveat for MySQL prod:** Prisma maps
  `String` → `VARCHAR(191)` on MySQL, which truncates long note/message bodies. **Recommended
  prod DB is Postgres** (`String` → `text`, unbounded). If MySQL is required, add `@db.Text`
  to `Note.body`, `MessageTemplate.body`, `MessageLog.bodySnapshot`, `Activity.payload`,
  `Segment.criteria` when switching the datasource.
- `@default(cuid())`, `@default(now())`, `@updatedAt` all work on every target — used freely.

## 3. CRM mirror vs. live Shopify data

Shopify is the source of truth for customers/orders. The local `Contact` is a **read-mirror +
augmentation**. Per the brief, full profile / order history / authoritative spend are fetched
**live** from GraphQL on the detail page. **However**, Phase 2 requires list filtering/sorting
by "spend tier", which is impractical against live data per row. Decision: the mirror caches
**lightweight** spend signals (`amountSpent`, `currencyCode`, `ordersCount`, `lastOrderAt`)
maintained by backfill + `orders/*` webhooks, used only for fast list filter/sort. The detail
page still shows live authoritative figures. `amountSpent` is a **`Float`** here (not the
String used elsewhere for money): it is a non-authoritative, denormalized sort/filter key, and
a String column would sort lexicographically. This is the one deliberate exception to the
"money is a String" rule in §2 — it is never used for financial calculation, only ordering.

**Spend-cache maintenance (live-refresh model):** the cache (`amountSpent`/`ordersCount`/
`currencyCode`/`lastOrderAt`) is kept current by a **live per-customer GraphQL refresh** —
`refreshContactFromShopify` fetches authoritative `amountSpent`/`numberOfOrders`/`lastOrder`
and writes them absolutely. It runs on the **install backfill** and on **every `customers/*`
and `orders/*` webhook** (the handlers call `upsertAndRefreshContact` / `recordOrderAndRefresh`
with the webhook's `admin` context). This is the authoritative source — it stays correct after
refunds, edits and cancellations even though Shopify removed `total_spent`/`orders_count` from
the customer webhook payload (2025-01+). The `orders/*` increment remains only as an **optimistic
fallback** if a refresh fails (transient rate-limit); the refresh, when it succeeds, overwrites
it with the truth, so there is no increment-vs-absolute drift in steady state.

Order webhooks are made idempotent for the **timeline event** by a dedicated **`ProcessedOrder`**
table with a unique `(shop, orderGid)` constraint — the first delivery of an order GID "wins"
(atomic insert), so concurrent `orders/create` + `orders/paid` deliveries can't duplicate the
`ORDER_PLACED` activity or double-apply the optimistic increment. `lastOrderAt` is advanced
monotonically in the increment path; the refresh sets the authoritative last-order date. The
detail page always shows live figures regardless. `amountSpent` is a **`Float`** sort/filter key
(see above) — the one deliberate exception to the "money is a String" rule.

The detail page is a **Customer 360**: a tabbed record (Summary/Orders/Activity/Notes &
Tasks/Details) with an identity header, a KPI bar, and derived **insights** (`app/lib/crm/insights.ts`:
AOV, days-since-last-order, tenure, order frequency, at-risk flag, top products) computed from
live Shopify data. The customer GraphQL query uses the non-deprecated `defaultEmailAddress` /
`defaultPhoneNumber` fields (the legacy `email`/`phone`/`*MarketingConsent` fields are deprecated
at 2026-04).

## 4. Scopes (minimal)

`shopify.app.toml` `scopes = "read_customers,read_orders"`.
- `write_customers` is **intentionally omitted** (writing CRM tags/metafields back to the
  Shopify customer is the optional stretch in the brief). Add it only when that feature lands.
- `read_all_orders` is **deliberately NOT requested** — it requires Shopify approval. The app
  works within the trailing 60-day order window plus locally logged `orders/*` webhook events.
- The scaffold's demo scopes (`write_products,write_metaobjects,write_metaobject_definitions`)
  and the demo product-metafield / `Example` metaobject definitions in the toml were removed —
  they belong to the template demo, not the CRM, and would force unnecessary write scopes.

## 5. Secrets & encryption

- Brevo API key is **BYOK**, stored **encrypted at rest** with **AES-256-GCM**. The key for
  encryption comes from env `ENCRYPTION_KEY` (32-byte secret, hex or base64). Ciphertext is
  stored as a single `iv:authTag:ciphertext` base64 bundle in `ShopSettings.brevoApiKeyEncrypted`.
- The plaintext key is **never** returned to the client, logged, or placed in URLs/bundles.
  The UI shows only connected/not-connected + a masked indicator.
- All Brevo HTTP calls happen server-side (loaders/actions/`app/lib/brevo/*`).

## 6. Billing

Left out of the core build per the brief. `app/lib/billing.server.ts` ships a documented,
isolated stub with a commented integration point using the template's billing helpers, so a
recurring/usage plan can be enabled later without rework.

## 7. Testing

- Unit tests (Vitest) cover the isolated, security-/correctness-critical modules: crypto
  (encrypt/decrypt round-trip + tamper detection), phone E.164 normalization, merge-variable
  rendering, and the Brevo client (mocked `fetch`).
- Phone validation is a **self-contained E.164 normalizer** (no `libphonenumber-js` dependency)
  to keep the build offline-installable and fully deterministic. `libphonenumber-js` is the
  recommended upgrade for exhaustive national-format parsing — noted, not blocking.

## 7a. TypeScript config — app-bridge global types

`tsconfig.json` `compilerOptions.types` adds `@shopify/app-bridge-types` alongside the
scaffold's `@shopify/polaris-types`. The Polaris `<s-app-nav>` element's JSX type ships in
`@shopify/app-bridge-types`, which the scaffold only loaded transitively because its demo
`app._index.tsx` imported `useAppBridge`. Declaring it in `types` makes the app-bridge web
components type-check in every route regardless of per-file imports.

## 8. Verification constraints in this environment

`shopify app dev` requires interactive Partner auth, a tunnel, and a real dev store, which are
not available in this build sandbox. Per-phase acceptance is therefore verified by the
strongest local gates available: `prisma migrate` + `prisma generate`, `npm run typecheck`
(`react-router typegen && tsc --noEmit`), `npm run build`, ESLint, and `vitest`. Live
embedded-install verification is left for the user's Partner account + dev store.

## 9. Inbound (two-way) messaging — Brevo Conversations webhooks

Receiving customer email/SMS replies uses **Brevo Conversations webhooks**
(`conversationStarted`/`conversationFragment`/`conversationTranscript`), one endpoint that captures
inbound across channels (email + two-way SMS via a Brevo dedicated number, plus chat/social we
ignore). Chosen over **Inbound Parsing** (`type:inbound`, REST-creatable but email-only + needs MX
delegation) because it covers SMS too.

- **Not auto-registerable.** The REST `/v3/webhooks` API only creates `transactional`/`marketing`/
  `inbound` — Conversations webhooks must be added **manually** in Brevo (Conversations → Settings →
  Integrations → Webhooks). So the app generates a per-shop URL + shows setup steps in Settings.
- **Public endpoint** `app/routes/webhooks.brevo.$token.tsx` — NOT `authenticate.webhook` (auth is
  per-route). Security: a high-entropy `brevoInboundToken` in the URL path resolves the shop
  (`findShopByInboundToken`), plus an optional `brevoInboundSecret` (encrypted) checked against the
  request's Bearer/basic-auth via `safeEqual`. Body size-capped; always returns 200 on authenticated
  requests (no Brevo retry storms); the shop is derived **only** from the token, never the body.
- **Ingestion** (`app/lib/crm/inbound.server.ts`): keep only `type:"visitor"` messages (our own
  outbound shows as `agent` and is ignored → no duplicate-of-outbound). Channel from `visitor.source`
  (permissive map; falls back to inferring from sender shape). Match a `Contact` by email/phone within
  the shop; store an **INBOUND `MessageLog`** with `direction` + `providerEventId` (unique
  `(shop, providerEventId)` → P2002 no-op on redelivery, mirroring `ProcessedOrder`); log an
  `EMAIL_RECEIVED`/`SMS_RECEIVED` activity. `status` is meaningless for inbound (UI gates the badge on
  `direction`).
- **Unmatched senders are skipped + logged** — `MessageLog.contactId` is required and the mirror
  assumes every Contact maps to a Shopify customer, so auto-creating "shadow" contacts is out of scope
  (would need a nullable `shopifyCustomerId`). A future "unmatched inbox" could revisit.
