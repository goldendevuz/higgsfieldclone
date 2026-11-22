# Vireo — AI image & video studio

Vireo is a production-grade studio for generating images and video with every
model the [Higgsfield REST API](https://docs.higgsfield.ai) exposes: Seedance,
Kling, Wan, Soul, Cinema Studio, Genjutsu, MiniMax, LTX, PixVerse, Grok,
Recraft, Qwen, Ideogram and more — **47 picker entries covering 81 documented
endpoints**. Users sign in with a magic link, pay with Stripe credits, and keep
everything in a personal library. The UX follows higgsfield.ai (dark UI, lime
accent, generator panel, justified feeds); the brand, copy and media are ours.

**Two generation providers, side by side.** Besides Higgsfield, models can run
through [OpenRouter](https://openrouter.ai) (pay as you go, no subscription):
**Seedance 2.5** and the cheap **Seedance 2.0 Mini** (plus 23 more text and
image-to-video models: Seedance 2.0 / Fast / 2.5 Flash, Veo 3.1 family, Gemini
Omni, Grok Imagine, Wan 3.0, HappyHorse, MiniMax H3 / Hailuo, Runway Gen-4.5,
FLUX.3 Video, Mischief 1) are in the picker as "(OpenRouter)" entries. Configure either provider, or both; a provider without
credentials is simply not offered. See [OpenRouter](#openrouter-video-on-a-small-budget).

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack), React 19, TypeScript strict |
| UI | Tailwind v4 + shadcn (Base UI), Quanta tokens, lucide, zustand, @tanstack/react-virtual — scaffolded from [`higgsfield-ai/app-templates`](https://github.com/higgsfield-ai/app-templates) |
| Auth | Auth.js v5 (`next-auth@5`), magic links via Resend, database sessions |
| Email | Resend + React Email (`emails/`) |
| Database | MongoDB (Atlas replica set) — one client shared by the Auth.js adapter and the app |
| Payments | Stripe Checkout, Billing, Customer Portal, webhooks |
| Generation | Higgsfield REST API and/or OpenRouter video API, one server-side key each |
| Media | Cloudflare R2 (every output is copied; the platform keeps outputs ≥ 7 days) |

## Quick start (fully offline)

Nothing external is needed to run the whole product locally: a local MongoDB
replica set, a mock Higgsfield API and a dev mailbox stand in for the services.

```bash
pnpm install
cp .env.example .env.local      # then fill AUTH_SECRET: openssl rand -base64 32
```

In three terminals:

```bash
pnpm db:dev            # MongoDB replica set on :27027 (data in .data/mongo)
pnpm mock:higgsfield   # mock platform on :4010 ("[fail]", "[nsfw]", "[slow]" in a prompt steer outcomes)
pnpm mock:openrouter   # optional: mock OpenRouter on :4020 ("[fail]", "[slow]", "[402]")
pnpm dev               # http://localhost:3000
```

Once, after the database is up:

```bash
pnpm db:init --admin=you@example.com   # indexes + Effects presets (+ admin role)
```

For offline development set in `.env.local`:
`MONGODB_URI=mongodb://127.0.0.1:27027/?replicaSet=vireo`,
`HF_API_BASE_URL=http://localhost:4010`, `HF_CREDENTIALS=mock:mock`,
`HF_PRICE_GUARD=false` (the mock's estimate is a constant $0.01, which the
guard would read as repricing), `SIGNUP_BONUS_CREDITS=200`, `E2E_TEST_MODE=true`. For the OpenRouter mock add
`OPENROUTER_API_KEY=mock-key` and
`OPENROUTER_API_BASE_URL=http://localhost:4020/api/v1` (optionally
`OPENROUTER_WEBHOOK_SECRET` + `OPENROUTER_WEBHOOK_BASE_URL=http://localhost:3000`
to exercise callbacks). Magic links are printed to the
dev-server log (no Resend key needed); media is stored under `.data/media`; the
reconciler runs in-process every 5 s because there is no cron or webhook tunnel.

## Real services

| Service | What to set | Notes |
|---|---|---|
| MongoDB Atlas | `MONGODB_URI`, `MONGODB_DB` | Any replica set (Atlas M0 works). Run `pnpm db:init` against it. |
| Resend | `AUTH_RESEND_KEY`, `EMAIL_FROM` | Verify the sending domain first. |
| Higgsfield | `HF_API_BASE_URL=https://api.higgsfield.ai`, `HF_CREDENTIALS=key_id:key_secret` | Keys from [console.higgsfield.ai](https://console.higgsfield.ai). Then run `pnpm pricing:sync`. Optional if OpenRouter is set. |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_API_BASE_URL` (default `https://openrouter.ai/api/v1`) | Key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys); needs credits. Optional if Higgsfield is set. |
| Webhooks | `HF_WEBHOOK_SECRET`, `HF_WEBHOOK_BASE_URL` (OpenRouter: `OPENROUTER_WEBHOOK_SECRET`, `OPENROUTER_WEBHOOK_BASE_URL`, each falling back to the HF value) | Public HTTPS origin. Locally: `cloudflared tunnel --url http://localhost:3000` and put the URL here. Without it the reconciler finishes runs by polling. |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | Create 6 recurring prices (3 plans × month/year) and 3 one-time top-up prices. |
| R2 | `R2_*` | Public bucket or custom domain for `R2_PUBLIC_BASE_URL`; CORS: allow GET from your origin. |

Local Stripe webhooks:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`. Test cards: `4242 4242 4242 4242`.

### Pricing

`credits = ceil(platform USD × CREDIT_MARKUP / CREDIT_USD_VALUE)` for both
providers. Higgsfield prices come from its estimate endpoint:

```bash
pnpm pricing:sync            # calls POST /estimate/{path} for every endpoint
```

It writes `lib/billing/pricing.generated.json` (commit it). Token-metered
models (Seedance, Cinema Studio, Wan 3.0, …) return a pricing description
instead; their rules are derived from it in `lib/billing/pricing-table.ts`.
Endpoints with no verified price are not sold on the live API until an admin
sets one in **Admin → Models & pricing**, and a price guard compares each
submit against the live estimate (`HF_PRICE_GUARD`). Details:
`docs/runbook.md` → Pricing.

## OpenRouter: video on a small budget

OpenRouter is a pay-as-you-go gateway: add a few dollars of credit, no
subscription. The studio offers two Seedance models through it:

| Picker entry | Use it for | Price (provider cost, no video input) |
|---|---|---|
| **Seedance 2.0 Mini (OpenRouter)** | cheap drafts, prompt tests; 4-15 s | about $0.034/s at 480p (a 4 s clip ≈ $0.13) |
| **Seedance 2.5 (OpenRouter)** | the final shot; 4-30 s, 480p / 720p / 1080p | about $0.103/s at 480p (4 s ≈ $0.41), $0.231/s at 720p |

Prices are derived from OpenRouter's public model list
(`pnpm pricing:sync:openrouter`) and charged with the usual markup. Audio does
not change the price. Both models take text, a first (and last) frame, or up to
9 reference images.

**Recommended workflow:** draft with Seedance 2.0 Mini at 480p (the default),
iterate on the prompt, then render the keeper once on Seedance 2.5 (still 480p
by default; pick 720p deliberately, it costs about 2.2×).

Budget protection is on by default:

* Every OpenRouter model starts at **480p and 4 s**.
* The Generate button shows the price in credits before you submit, and a
  warning appears above `OPENROUTER_WARN_USD` (default $0.75; 15 s at 480p on
  Seedance 2.5 is about $1.6).
* Runs above `OPENROUTER_MAX_USD_PER_RUN` (default $2, `0` disables) are
  refused before anything is charged.
* Failed jobs are not billed by OpenRouter and are refunded to the user once.
  After submit, OpenRouter jobs **cannot be canceled** (it documents no cancel
  endpoint), so the Cancel button is hidden for them.
* The server logs OpenRouter's reported `usage.cost` against the USD basis we
  charged from; an error line means the price table is too low.

### More OpenRouter models

Every text / image-to-video model in `GET /api/v1/videos/models` whose request
fits the documented body and whose price comes from its `pricing_skus` is in the
picker (ids end in `-openrouter`; see `docs/model-catalog.md` for the table and
the skipped ones). Each starts at its cheapest listed resolution and 4 s (or the
shortest allowed). Three price shapes: token-priced (Seedance), USD or cents per
output second per resolution (Wan, HappyHorse, Hailuo, Grok, Runway, FLUX.3,
Mischief, Gemini Omni), and Veo's resolution × audio table. Grok adds its
per-input-image fee. `pnpm pricing:sync:openrouter` refreshes the list.

Not offered through OpenRouter: Edit and Extend (`previous_job_id`) and audio or
video references. See `docs/model-catalog.md` for why.

To try it with a real key, first run the dry run, then the real thing (each
creates exactly one job and prints what it billed):

```bash
export OPENROUTER_API_KEY=sk-or-v1-...        # or put it in .env.local; never commit it
pnpm smoke:openrouter mini                    # dry run, shows the estimate
pnpm smoke:openrouter mini --yes              # 4 s, 480p, Seedance 2.0 Mini (about $0.14)
pnpm smoke:openrouter seedance-2.5 --yes      # optional: 4 s, 480p, Seedance 2.5 (about $0.41)
```

### Expand prompt (free)

With an OpenRouter key, the video and image prompt boxes get an **Expand prompt**
button: it turns a one-line idea into a detailed prompt (opening frame, timed
beats that match the chosen duration, camera, look and, with audio on, an
`Audio:` line; images get subject/setting/composition/look). **Undo** restores
your text. It costs no credits; the provider cost is a fraction of a cent per
use (default model `anthropic/claude-haiku-5.5`, change with `OPENROUTER_EXPAND_MODEL`)
and is logged as `[expand] ... cost $...`. Limit: 20 per user per hour. The
button is hidden when `OPENROUTER_API_KEY` is unset. The mock
(`pnpm mock:openrouter`) answers `/chat/completions` offline.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server (regenerates the model barrel on change) |
| `pnpm build` | Production build + client-bundle secret scan |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / ESLint |
| `pnpm test` | Vitest: catalog snapshots (every model), pricing, ledger, lifecycle, webhooks (in-memory MongoDB replica set) |
| `pnpm test:e2e` | Playwright against a running stack (`E2E_BASE_URL` for a preview deploy; `E2E_OPENROUTER=true` adds the OpenRouter flows and needs `pnpm mock:openrouter`) |
| `pnpm models` | Regenerate `generation/catalog/models.generated.ts` |
| `pnpm db:dev` / `pnpm db:init` | Local MongoDB / indexes + preset seed |
| `pnpm mock:higgsfield` | Local mock of the Higgsfield REST API |
| `pnpm mock:openrouter` | Local mock of the OpenRouter video API (no key, no spend) |
| `pnpm pricing:sync` | Derive Higgsfield prices from the estimate endpoint |
| `pnpm pricing:sync:openrouter` | Refresh OpenRouter prices from its public `/videos/models` list (no key needed) |
| `pnpm smoke:openrouter mini\|seedance-2.5 [--yes]` | One real OpenRouter job from the CLI; a dry run without `--yes` |

## Adding a model

1. Add `generation/catalog/models/<family>.ts` with a default export of
   `ModelEntry[]` (copy a neighbour). Map UI settings to the **documented**
   body fields in `toPlatform`, and cite the docs URLs in the header comment.
2. `pnpm models` (the dev server does this automatically).
3. Add a price rule for each new endpoint path in `lib/billing/pricing-table.ts`
   (or run `pnpm pricing:sync`).
4. `pnpm test -u` updates the catalog snapshots; review them against the docs.

A model served by another provider sets `platform: "openrouter"` and maps to
that provider's body; see `generation/catalog/models/seedance-openrouter.ts`.

Adding the first **audio** model makes the Audio nav item and `/audio` appear
automatically — the surface, tiles, player and pricing are already wired.

## Architecture

```
Browser ── prompt dock / panel ─▶ server action submitGeneration()
   │                                 validate vs catalog → price → debit (Mongo txn)
   │                                 → POST {model path}?hf_webhook=… → store request_id
   ├─ PUT file ─▶ presigned platform upload URL (key never leaves the server)
   └─ polls GET /api/generations/status (our DB only) every 3.5 s while in flight
Higgsfield ── webhook ─▶ /api/webhooks/higgsfield (HMAC token) ─▶ finalizeGeneration()
OpenRouter ── callback_url ─▶ /api/webhooks/openrouter (HMAC token) ─▶ finalizeGeneration()
Vercel Cron ─▶ /api/cron/reconcile ─▶ stuck/ambiguous runs, refunds, copy retries, annual grants
finalizeGeneration(): re-fetch status from the generation's provider → copy outputs to R2
  (OpenRouter: authenticated download with the server-side key) → complete, or refund failed/nsfw/canceled once
Stripe ─▶ /api/webhooks/stripe ─▶ ledger grants (idempotent on Stripe ids)
```

Key files: `lib/generations/{submit,finalize,reconcile,cancel}.ts`,
`lib/billing/{price,ledger,stripe-events}.ts`, `lib/higgsfield/client.ts`,
`lib/openrouter/{client,pricing,webhook}.ts`,
`generation/catalog/**`, `components/generator/**`, `auth.ts`.

## Deployment (Vercel)

1. Create the Atlas cluster, R2 bucket, Resend domain and Stripe products.
2. Set every `(required)` variable from `.env.example` in Vercel (Production + Preview).
3. `vercel.json` schedules `/api/cron/reconcile` every minute (send `CRON_SECRET`).
4. Stripe webhook endpoint: `https://<domain>/api/webhooks/stripe` with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `charge.refunded`.
5. `pnpm db:init` against production once; `pnpm pricing:sync` with the live key.

See `docs/runbook.md` for operations, `docs/decisions.md` for every default and
docs-vs-template disagreement, and `docs/model-catalog.md` for the model table.

## Origin and attribution

This codebase is **Vireo**, by Albert Shiney
([albertshiney/higgsfieldclone](https://github.com/albertshiney/higgsfieldclone)),
whose author said anyone may use it. Thank you; the OpenRouter provider, mock
and budget protections are additions on top of that work. Keep this credit when
you fork or redistribute.

The Studio UI is adapted from `higgsfield-ai/app-templates` (no LICENSE file
as of 2026-09-26 — re-check before launch; see `docs/decisions.md`).
