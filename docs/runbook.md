# Runbook

Operating Vireo in production. Everything below is idempotent unless noted.
Generations run on Higgsfield, OpenRouter, or both; the generation's `platform`
field says which (documents without it are Higgsfield).

## Health at a glance

| Signal | Where | Healthy |
|---|---|---|
| Reconciler | Vercel → Cron → `/api/cron/reconcile` | 200 every minute; JSON summary with small numbers |
| OpenRouter balance | openrouter.ai → Credits | Comfortably above a few runs; a 402 means it is empty |
| In-flight runs | Admin → Generations → status `queued` / `in_progress` | Nothing older than `RUN_TIMEOUT_MINUTES` (30) |
| Pending submits | Admin → Generations → `pending_submit` | Empty after 2 minutes |
| Pricing | Admin → Models & pricing | No pink "placeholder" or "Reprice" badges |
| Billing flags | Admin → Users (pink ⚠ next to an email) | None unreviewed |

## Generation lifecycle

`pending_submit → queued → in_progress → completed | failed | nsfw | canceled`

* Credits are debited in the same transaction that creates the generation.
* `failed`, `nsfw`, `canceled` and timeouts refund exactly once (ledger key
  `{reason, refType, refId, bucket}`); the reconciler re-runs any refund that
  didn't land.
* The webhook never trusts its payload — it re-fetches the status from the
  provider that ran the job (Higgsfield `GET /requests/{id}/status`, OpenRouter
  `GET /videos/{id}`).
* OpenRouter status mapping: `pending` → queued, `in_progress`, `completed`,
  `failed` and `expired` → failed (refunded once), `cancelled` → canceled.
  `generations.hfRequestId` holds the provider's job id for either platform
  (the field name is historical).

### A run is stuck

1. Admin → Generations, filter by status. Note the platform request id.
2. The user can press **Check status** on the tile (after 90 s), or wait for
   the reconciler (runs every minute; anything untouched for 3 minutes is
   re-fetched).
3. After `RUN_TIMEOUT_MINUTES` the reconciler cancels (if queued) or fails the
   run and refunds. A late platform success is still delivered to the user
   (logged as "late delivery"), without re-charging.

### Ambiguous submits (`pending_submit` with no request id)

The platforms have no idempotency key, so timeouts/502/504 on submit are never
retried automatically (OpenRouter: also 500 and a 2xx without a job id). After 2 minutes the reconciler marks them failed and
refunds. If a webhook for that generation arrives later, the result is attached
and delivered free.

### OpenRouter jobs cannot be canceled

OpenRouter documents no cancel endpoint, so the studio hides Cancel on its jobs
and refuses the server action. A job runs to completion or failure; a failed
one is not billed and is refunded to the user once. If a job outlives
`RUN_TIMEOUT_MINUTES` the reconciler fails and refunds it without any cancel
call; should OpenRouter finish it later, the callback or the next poll still
delivers the video free of charge (logged as "late delivery"), so that run costs
us the provider fee. Keep the timeout generous.

### OpenRouter downloads

The finished video is fetched server-side with `Authorization: Bearer
$OPENROUTER_API_KEY` from the `unsigned_urls` (the key is sent only to the
configured API origin) and streamed into R2; the browser never sees the key or
the provider URL. If the copy keeps failing the run stays in flight and is
retried every reconciler pass; after four attempts the signed key-less `urls`
from the job are used as a temporary fallback until the copy succeeds.

### Platform errors in logs

| Log | Meaning | Action |
|---|---|---|
| `OPERATOR ALERT: Higgsfield rejected HF_CREDENTIALS (401)` | Key revoked/rotated | Update `HF_CREDENTIALS`, redeploy |
| `OPERATOR ALERT: Higgsfield account is out of credits (403)` | Platform balance empty | Top up the platform account |
| `OPERATOR ALERT: Platform concurrency limit reached` | Account concurrency cap | Ask Higgsfield for higher limits; lower plan concurrency |
| `OPERATOR ALERT: OpenRouter rejected OPENROUTER_API_KEY (401)` | Key revoked/rotated | Update `OPENROUTER_API_KEY`, redeploy |
| `OPERATOR ALERT: OpenRouter account is out of credits (402)` | OpenRouter balance empty | Add credits at openrouter.ai/credits; users see "temporarily unavailable" and are refunded |
| `[pricing] provider cost above our price basis` | OpenRouter billed more than our table | Run `pnpm pricing:sync:openrouter`; check the token formula in `lib/openrouter/pricing.ts` |
| `[pricing] live cost … exceeds our price basis` | Price table stale | Admin → Models & pricing, or `pnpm pricing:sync` |

## Pricing

* `pnpm pricing:sync` (needs `HF_CREDENTIALS`) rebuilds
  `lib/billing/pricing.generated.json` from `POST /estimate/{path}`: every
  endpoint the catalog reaches, every enum/switch value it offers there, and
  the duration curve. Commit and deploy. Endpoints that fetch their inputs
  need reachable sample media: `PROBE_IMAGE=https://… PROBE_VIDEO=https://…
  pnpm pricing:sync` (any public image and ~5 s MP4).
* Token-metered endpoints (Seedance, Cinema Studio, Wan 3.0, Genjutsu,
  MiniMax H3 references, Marketing Flare/Sunburst) answer the estimate with a
  pricing *description*; the sync prints it. Their rules are hand-derived in
  `lib/billing/pricing-table.ts` (`source: "description"`, text quoted next to
  each rule) — re-check them when the sync shows a changed description.
* **Unverified** (placeholder) prices are never sold against the live API: the
  Generate button says the option isn't available yet. As of 2026-09-26 that
  is Kling motion control (2.6 / 3.0, std / pro), Kling O3 / Omni video edit
  (their estimate returns 500) and Marketing Flare / Sunburst (token-billed
  with no per-image rate). Look the cost up in the Higgsfield console and set
  it in Admin → Models & pricing → ✎.
* Per-endpoint overrides: Admin → Models & pricing → ✎. Takes effect within 30 s.
* The price guard blocks a submit only when the live cost is > 25 % above our
  basis (and flags the model at > 1 %).

### OpenRouter pricing

* `pnpm pricing:sync:openrouter` (no key needed) rewrites
  `lib/openrouter/models.generated.json` from the public
  `GET /api/v1/videos/models`; the rules in `lib/openrouter/pricing.ts` are
  derived from it: USD per video token × tokens per second
  (`width × height × 24 / 1024`) at each listed size, rounded **up** to the
  worst case so a price is never below the real cost. Commit the JSON.
* The token formula is an assumption carried over from Seedance's published
  billing; it matches the per-second figures we were given for Seedance 2.5.
  The first real run proves it: the server logs `provider billed $X, our basis
  $Y` at finalize, and `generations.providerCostUsd` keeps X.
* Budget limits: `OPENROUTER_WARN_USD` (UI warning, default 0.75) and
  `OPENROUTER_MAX_USD_PER_RUN` (refuse above, default 2, `0` = off).
* There is no Higgsfield-style price guard for OpenRouter (no estimate endpoint).

### First real OpenRouter run (smoke test)

Spends real money, one job per command, nothing is sent without `--yes`:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...        # not committed; or in .env.local
pnpm smoke:openrouter mini                    # dry run: prints model, 4 s, 480p, estimate
pnpm smoke:openrouter mini --yes              # Seedance 2.0 Mini, 4 s, 480p (about $0.14)
pnpm smoke:openrouter seedance-2.5 --yes      # optional: Seedance 2.5, 4 s, 480p (about $0.41)
```

It polls the job, downloads the MP4 with the key into `.data/smoke/`, and prints
`usage.cost` against our estimate ("within our price basis" or an error to fix).
Then check the callback path on a deployed URL (`OPENROUTER_WEBHOOK_*` set):
generate once in the app and confirm the log line `POST /api/webhooks/openrouter`.

## Credits and billing

* Adjust a balance: Admin → Users → **Adjust credits** (ledger `admin_adjust`
  with a note the user sees in their history).
* Stripe events are deduplicated (`stripe_events`) and every grant is keyed on
  a Stripe id. Replaying an event from the Stripe dashboard is safe.
* Refunded top-ups claw back credits (never below zero). If the credits were
  already spent the user is flagged — decide in Admin → Users, then clear the
  flag.
* Subscription invoices **reset** plan credits; cancellation keeps them until
  the period ends (`customer.subscription.deleted` zeroes the plan bucket).
* Annual plans get monthly grants from the reconciler (`nextGrantAt`).

## Moderation

Admin → Moderation lists reported public generations. **Unpublish** removes an
item from Community and blocks re-publishing; **Dismiss** closes the reports.

## Secrets rotation

| Secret | Rotation |
|---|---|
| `AUTH_SECRET` | Rotating signs everyone out (database sessions stay, cookies become invalid). |
| `HF_WEBHOOK_SECRET` | In-flight runs' webhook tokens stop verifying; the reconciler finishes them. |
| `HF_CREDENTIALS` | Create the new key in the console first, deploy, then revoke the old key. |
| `OPENROUTER_API_KEY` | Create the new key at openrouter.ai/settings/keys first, deploy, then delete the old one. |
| `OPENROUTER_WEBHOOK_SECRET` | In-flight OpenRouter runs' callback URLs stop verifying; the reconciler finishes them. |
| `STRIPE_WEBHOOK_SECRET` | Roll in the Stripe dashboard; Stripe retries failed deliveries. |
| `CRON_SECRET` | Update in Vercel; Vercel Cron sends the new value automatically. |

## Data

* Indexes: `pnpm db:init` (idempotent). Required for the ledger's exactly-once
  guarantees — run it before the first deploy.
* Outputs live in R2 under `u/{userId}/{generationId}/{n}.{ext}`; uploads under
  `u/{userId}/uploads/`. Deleting a generation deletes its objects.
* Backups: enable Atlas continuous backup; R2 has no versioning by default.

## Launch checklist

- [ ] Every `(required)` variable in `.env.example` set in Production, and at least one provider (`HF_CREDENTIALS` and/or `OPENROUTER_API_KEY`).
- [ ] OpenRouter only: credits added, `pnpm smoke:openrouter mini --yes` run once, `OPENROUTER_MAX_USD_PER_RUN` set to taste.
- [ ] `pnpm db:init` against the production database.
- [ ] `pnpm pricing:sync` with the live key; no placeholder prices in admin.
- [ ] Final plan prices and credit allowances in `lib/billing/plans.ts`; Stripe prices match.
- [ ] Stripe in live mode, webhook endpoint + events configured, test purchase refunded.
- [ ] Resend domain verified; a real magic link arrives.
- [ ] R2 CORS allows GET from the site origin.
- [ ] Legal pages replaced (`/legal/*`).
- [ ] `higgsfield-ai/app-templates` licence re-checked.
- [ ] `pnpm test:e2e` green against the preview deploy (`E2E_TEST_MODE` on the preview only).
