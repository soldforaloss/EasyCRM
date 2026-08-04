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

`shopify.app.toml` `scopes = "read_customers,read_orders,read_locations"`.
- `read_locations` mirrors store names and joins POS order attribution through
  `Location.legacyResourceId`; it is the only scope added for the clienteling pivot.
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

---

# Production-readiness changes (2026-08-03)

The sections below record the changes made to take the app from "feature-complete build" to
"deployable". They supersede §2, §6 and §8 where they conflict.

## 10. Marketing consent is enforced, not just displayed

**Problem.** The app fetched `emailMarketingState` / `smsMarketingState` from Shopify and rendered
them on the contact detail page, but the send path never consulted them. Every contact with an
address was messageable regardless of whether they had opted in. Outbound email carried no
unsubscribe mechanism and no postal address, and contact SMS was sent with Brevo's
`type: "transactional"`. That combination is a CAN-SPAM / TCPA / GDPR exposure for the merchant and
a near-certain App Store rejection.

**Decision.**

- `Contact.emailMarketingState` / `Contact.smsMarketingState` are now mirrored columns, written by
  the install backfill and refreshed on every `customers/*` webhook via `fetchCustomerSyncFields`.
  They are written **unconditionally**, including back to `NULL` — an opt-out has to be able to
  clear a previously granted consent, so these are never spread-guarded.
- `hasMarketingConsent()` in `constants.ts` is the single definition: **only `SUBSCRIBED` permits
  contact.** `PENDING` (double opt-in unconfirmed) and `NULL` (never synced) do not. The gate
  **fails closed** — a wrong "allow" is a legal violation, a wrong "deny" is one unsent message.
- `sendOneToContact()` in `messaging.server.ts` is the **only** path to the wire, and it checks
  consent before any credential work or network call. There is deliberately **no bypass parameter**.
  Single send and bulk send both route through it, so the gate cannot be sidestepped by a caller.
- Suppressed sends are recorded as `MessageLog.status = "SKIPPED"` with a `skipReason`, so the
  merchant can see exactly who was not contacted and why. A skip is **not** a failure and does not
  produce an `EMAIL_SENT` / `SMS_SENT` timeline activity.
- Consent is checked **before** address validity, so a non-consented contact is always recorded as
  `NO_CONSENT` rather than being masked by `NO_ADDRESS` — the two have different remedies.
- Every marketing email now carries a footer with the merchant's physical postal address and an
  opt-out link, plus `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 2369 / RFC 8058) for
  Gmail and Yahoo one-click unsubscribe. Brevo does not add these to `/v3/smtp/email` sends, so the
  app supplies them. One-click POST is advertised only for `https:` targets — RFC 8058 one-click is
  undefined for `mailto:`.
- **Email sending is blocked outright** until `ShopSettings.businessAddress` is set, because
  CAN-SPAM makes the address mandatory and there is no compliant way to send without it.
- Contact SMS is now sent as `type: "marketing"`. The Settings *test* send stays transactional: the
  merchant is messaging themselves with fixed boilerplate to verify configuration.

## 11. Bulk send is a durable job queue, not an inline loop

**Problem.** `sendBulk` iterated recipients inside the HTTP request — SMS strictly sequentially, one
Brevo call at a time — against a segment resolved at `pageSize: 1000`. Any real campaign would
exceed the platform request timeout mid-send, leaving a partial send with no resumption and no
record of where it stopped. The install backfill had the same shape on the OAuth callback, where a
large-catalog shop would fail the install.

**Decision.** A `Job` table plus an in-process worker (`app/lib/jobs/`).

- DB-backed rather than Redis-backed: Postgres is already required, and a second stateful dependency
  is not worth the operational cost for this workload. Throughput is bounded by the Brevo API anyway.
- Jobs are claimed with an **optimistic compare-and-set** on `status`
  (`updateMany where {id, status:"PENDING"}`). Exactly one worker's update can match, so multiple
  app instances share the queue safely without advisory locks or `SELECT … FOR UPDATE`.
- A bulk send writes one `MessageBatch` + one `SEND_ONE` job per recipient and returns immediately.
  Idempotency is layered: `Job.dedupeKey = send:<batchId>:<contactId>` makes re-enqueueing a no-op,
  and a unique `MessageLog (batchId, contactId)` means even a doubly-executed job cannot send twice
  (the send is *claimed* before it is attempted, not logged after).
- Batch counters are **derived** from `MessageLog` rows rather than incremented, because increments
  would drift on every job retry.
- Failures retry with exponential backoff up to `maxAttempts`, then park in `FAILED` — jobs are
  never silently dropped. `RUNNING` jobs whose worker died are reclaimed after 5 minutes.
- Handlers distinguish transient from permanent: a handler that throws is retried, so per-recipient
  outcomes already recorded on the `MessageLog` (no consent, bad address, Brevo 4xx) must **not**
  throw. Only transport failures do.
- The install backfill is now an enqueued `BACKFILL_CUSTOMERS` job, so OAuth returns immediately.

**Deployment constraint.** The worker requires a process that stays alive between requests. The
Dockerfile target satisfies this; a freeze-between-requests serverless platform does not, and would
need a dedicated always-on worker process that this build does not ship. `RUN_JOB_WORKER=false`
disables the loop on a given instance.

## 12. Observability and abuse control

- `app/lib/logger.server.ts` emits one JSON object per line (level, event, timestamp, context), so
  logs are searchable and alertable. Keys matching `api_key|secret|token|password|authorization` are
  redacted before emission. The previous free-text `console.log` calls could not be queried on.
- `reportError()` forwards to Sentry when `SENTRY_DSN` is set **and** `@sentry/node` is installed.
  Sentry is an optional runtime dependency, not a hard one, so the app installs and runs without it;
  the import specifier is held in a variable so neither TypeScript nor Vite tries to resolve it.
- `/healthz` returns 200 with DB latency, or 503 when Postgres is unreachable, so an orchestrator can
  pull a broken instance out of rotation. `?deep=1` adds queue depth.
- The public inbound webhook is rate-limited in two stages: **per-IP before the database lookup**
  (so a flood of bogus tokens cannot become a flood of queries) and then per-shop. The buckets are
  in-process, so with N instances the effective global limit is N × capacity — adequate for stopping
  one bad actor from hammering an instance, but explicitly **not** a precise global quota.

## 13. Staff attribution

`Contact.ownerStaffId`, `Note.authorStaffId`, `Task.assigneeStaffId` and `MessageLog.sentByStaffId`
existed in the schema but nothing ever populated them — a multi-staff CRM with no audit trail.

The app uses **offline** Shopify tokens, so `session.onlineAccessInfo` is unavailable. The embedded
session token JWT does carry the staff user id in `sub`, and the Shopify library verifies it before
`authenticate.admin` resolves, so it cannot be spoofed by the client. `staffIdFromSessionToken()`
reads it. Attribution is **best-effort**: `sessionToken` is absent outside embedded contexts, so
every caller tolerates a null staff id rather than failing the write.

## 14. GDPR data requests are delivered, not just logged

`customers/data_request` previously assembled the customer's CRM data and `console.log`ged it. Since
Shopify provides no callback for data requests, the merchant — who has 30 days to respond — was left
with nothing to deliver. The obligation went unmet.

The assembled export is now persisted as a `DataRequest` row and surfaced at `/app/privacy`, where
staff can download it as JSON and mark it fulfilled. A row is written even when the shop holds no CRM
data for that customer, because "we hold nothing about you" is itself a required response.

`shop/redact` was also extended to delete `ProcessedOrder`, `MessageBatch`, `Job` and `DataRequest`
rows, which the original transaction missed.

## 15. Datasource: PostgreSQL only (supersedes §2)

§2 claimed the schema could move to production by swapping "`DATABASE_URL` + `provider`". That was
**not true**: the migration history was SQLite-dialect SQL, so `prisma migrate deploy` would fail
against Postgres. Worse, the Dockerfile ran `prisma migrate deploy` against a SQLite file inside the
container, so every redeploy would have destroyed all merchant data.

`prisma/migrations/` has been regenerated as a single Postgres baseline and the provider is now
`postgresql`. This was safe to do as a clean baseline **only because the app has never been
deployed** — with live installs it would have required a real migration path instead.

`app/db.server.ts` no longer falls back to `file:dev.sqlite` when `DATABASE_URL` is unset; it throws
at boot. A silent fallback to throwaway storage is worse than a failed start.

`docker-compose.yml` provides a matching local Postgres.

## 16. The Docker image never built (supersedes §8)

The Dockerfile ran `npm ci --omit=dev` and *then* `npm run build`. `vite` and `typescript` are
required (non-optional) peer dependencies of `@react-router/dev` and live in `devDependencies`, so
the build step had no bundler — the production image could not have been built successfully.

It is now a multi-stage build: the full dependency tree in the builder stage, only compiled output
plus production dependencies in the runtime stage, running as the non-root `node` user.
`.dockerignore` was extended so `.env` and local SQLite state can never be baked into an image.

## 17. Still outstanding

- **Billing remains a stub** (§6). `requireActivePlan` returns `active: true`. Wire it up before
  charging for the app.
- **No live verification.** §8 still applies: OAuth install, embedded App Bridge session tokens,
  live webhook HMAC delivery and the Brevo round trip have never run against a real store. Every
  gate passed so far is local. See README "Pre-launch checklist".
- `shopify.app.toml` still carries the placeholder `application_url = "https://example.com"`.

## 18. In-store clienteling pivot: locations, local orders and inferred visits

The pivot adds a tenant-scoped location and visit layer without replacing Shopify as the source of
truth. `Location.legacyId` joins the GraphQL location mirror to order-webhook `location_id` values;
`ProcessedOrder` remains the atomic `(shop, orderGid)` lock and is widened into the local order record
with POS attribution and JSON-as-String line items. `Visit` stores at most one row per customer,
location and shop-local calendar date, while `ContactLocation` counts each deduplicated POS order at
that location. `ContactPreference` and `StaffProfile` are schema foundations for later phases.

A visit means a Shopify order with `source_name = "pos"`, a location, a valid Shopify order timestamp
and an attached customer. Guest orders and non-purchase walk-ins are invisible by design. Multiple POS
orders in one store on one day coalesce to one Visit but still advance the per-location order rollup.
The order's `created_at` / GraphQL `createdAt` is authoritative because POS offline mode can deliver a
webhook late; receipt time is never substituted.

`ShopSettings.ianaTimezone` is self-healed from `shop { ianaTimezone }` during location sync and order
backfill. Visit dates are `YYYY-MM-DD` strings formatted in that timezone, avoiding UTC-boundary and
database-timezone ambiguity.

History uses accumulate-forward webhooks plus a trailing 60-day GraphQL backfill under `read_orders`.
Webhook delivery is strict first-insert-wins: `orders/create` and `orders/paid` duplicates are complete
no-ops. Backfill reuses the same order/visit choke point and may fill only still-null enrichment on a
legacy row, so it can repair pre-pivot orders without overwriting webhook data. Webhooks retain product
IDs from `line_items[].product_id`; GraphQL backfill leaves product IDs null rather than adding the
broader `read_products` scope. `read_all_orders` remains intentionally omitted.

Manual order resync is bounded to one queued backfill per shop per UTC hour. Running jobs renew a
worker-owned lease, and completion/failure updates require that same owner; the sequential worker
claims one job at a time so unstarted work cannot age into the stale-job recovery window.

## 19. In-store staff surfaces

`/app/today` is a store-scoped operating view, not a general order report. It shows the current
shop-local calendar day's inferred Visits for one active location, newest POS order first. A row
exists only when Shopify attached a customer to a POS sale at that location; walk-ins and guest
checkouts remain invisible under the Visit semantics in §18.

The default store is persisted per embedded Shopify staff member in `StaffProfile.homeLocationId`.
A `?location=<legacyId>` query value overrides that default for the current request, while changing
the selector persists the next default when a verified session-token staff id is available. Outside
embedded contexts the staff id may be absent, so the view asks for an explicit store selection and
continues without persisting it rather than failing.

Manual call, in-person and text outreach is recorded as append-only Activity rows. This path does
not use `MessageLog`, Brevo, or `sendOneToContact`: it records a conversation that already happened
and does not send anything to the customer. The marketing-consent gate in §10 therefore remains
mandatory for wire sends but deliberately does not block manual outreach logging.

The Tasks page defaults to **My tasks** when an embedded session token identifies the current staff
member and filters by `Task.assigneeStaffId`; staff can switch to **All tasks** explicitly. When no
staff identity is available, **All tasks** is the safe, usable default because filtering on a null
identity would hide work rather than identify its owner.

## 20. Size preferences: constrained derivation with explicit overrides

Size derivation uses only Shopify `variantTitle` option tokens, split on Shopify's ` / ` separator.
For this streetwear/sneaker merchant, exact `XXS`–`4XL` apparel tokens become `SHIRT_SIZE`; numeric
shoe tokens from 3.5 through 18 in 0.5 steps become `SHOE_SIZE`, with a trailing women's/men's
`W`/`M` marker removed. Colors, widths, free text and larger numbers such as 30/32 waist sizes are
ignored. This deliberately narrow heuristic favors false negatives over showing staff a confidently
wrong size.

Derived values are weighted by purchased quantity across accumulated local order line items. Ties
prefer the later observation because orders are processed oldest-first, making recent purchasing
behavior the useful tiebreaker. A `MANUAL` row always outranks `DERIVED` for display without deleting
the evidence-backed value; clearing the override immediately reveals the current derivation again.
Manual values remain app-owned and require no Shopify customer-write scope.
