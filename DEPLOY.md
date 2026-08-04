# Deploying Easy CRM (testing release)

The production Docker image is build- and boot-verified locally (see DECISIONS.md §16): it
builds, applies migrations on boot, starts the job worker, and serves `/healthz` 200. What
remains is account-bound and takes ~10 minutes once you're logged in.

Hosting requirement: an **always-on container host** (the in-process job worker dies on
freeze-between-requests serverless — DECISIONS.md §11). The steps below use Fly.io because
`flyctl` is already installed on this machine (`scoop`), but any Docker host works the same way.

## 1. Fly.io path

```bash
flyctl auth login
```

```bash
flyctl launch --no-deploy --copy-config
```

(Keeps the committed `fly.toml`. If the `easy-crm` app name is taken, accept a new name and
remember it — it becomes your hostname.)

Provision Postgres (managed Fly Postgres is fine for the pilot):

```bash
flyctl postgres create --name easy-crm-db --region phx --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 3
```

```bash
flyctl postgres attach easy-crm-db
```

(`attach` sets `DATABASE_URL` as a secret automatically.)

Set the remaining secrets (values from your Partner Dashboard app credentials; generate a fresh
ENCRYPTION_KEY, don't reuse the dev one):

```bash
flyctl secrets set ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") SHOPIFY_API_KEY=<client id> SHOPIFY_API_SECRET=<client secret> SHOPIFY_APP_URL=https://<your-app-name>.fly.dev
```

Deploy:

```bash
flyctl deploy
```

Verify: `https://<app>.fly.dev/healthz` returns `{"status":"ok",...}` and `?deep=1` shows the
job queue.

## 2. Any-other-Docker-host path

Run the image with these env vars and an HTTP route to port 3000: `DATABASE_URL` (Postgres),
`ENCRYPTION_KEY` (32-byte hex/base64), `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_APP_URL` (the public https URL), `PORT=3000`, `RUN_JOB_WORKER=true`. Exactly one
long-running instance should run the worker; migrations run automatically on boot.

## 3. Shopify configuration (after the host URL exists)

1. In `shopify.app.toml`: set `application_url = "https://<host>"` and the two
   `redirect_urls` to `https://<host>/auth/callback` style paths (replace the
   `https://example.com` placeholders), then:

```bash
shopify app deploy
```

   (Interactive Partner login. `include_config_on_deploy` is on, so this pushes the config —
   including the new `read_locations` scope; existing installs get a re-auth prompt.)

2. Partner Dashboard → Apps → EasyCrm → API access → **Protected customer data access**:
   select "Protected customer data" plus the **Name / Email / Phone / Address** fields with
   reasons. Without this, customer fields arrive null on any non-development store.

3. Install on a **development store first**. Verify in order: OAuth completes; `/healthz?deep=1`
   shows the backfill jobs draining; contacts appear; locations appear (Settings/Today store
   picker); a POS test order with an attached customer creates a Visit on the Today view.

## 4. Pilot checklist

The staff-facing pilot steps (POS customer-attach training, Today-view workflow, outreach
logging) are in README "Easy CRM (this app)". The one rule that makes or breaks visit
tracking: **attach the customer to every POS sale** — guest sales are invisible to the CRM.
