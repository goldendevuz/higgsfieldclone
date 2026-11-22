# Vireo — contract for coding agents

Vireo is a credit-metered AI image/video studio on the Higgsfield REST API and
OpenRouter's video API (a model's `platform` says which), scaffolded from
`higgsfield-ai/app-templates` (studio). Read `README.md`,
`docs/decisions.md` and `docs/model-catalog.md` before changing behaviour.

## Layout

- `app/(site)` marketing pages (expanded nav + footer) · `app/(studio)` full-height
  workspaces (generators, library) · `app/(app)` scrolling signed-in pages
  (account, billing, admin) · `app/api` route handlers · `app/actions` server actions.
- `generation/catalog/models/*.ts` — one file per model family; the barrel is
  generated (`pnpm models`). Never hand-edit `models.generated.ts`.
- `lib/higgsfield` and `lib/openrouter` (server-only provider clients),
  `lib/generations` (submit, finalize, reconcile, cancel, webhook, library), `lib/billing` (price, ledger, Stripe),
  `lib/db`, `lib/storage` (R2 / local), `lib/uploads.ts`, `auth.ts`.
- `components/generator` (panel, dock, canvas, picker), `components/studio`
  (template primitives: prompt box, gallery, lightbox, asset library),
  `components/site`, `components/billing`, `components/library`, `components/admin`.

## Invariants — preserve these

- **Server only:** the platform keys (`HF_CREDENTIALS`, `OPENROUTER_API_KEY`),
  Stripe/Resend/R2 secrets and model paths. `lib/higgsfield/**` and
  `lib/openrouter/**` import `server-only`; the OpenRouter key is only ever sent
  to the configured API origin. Request paths and bodies come from
  the catalog (`toPlatform`), never from the client.
- **Every server action / route handler** calls `auth()` (via `requireUser`)
  and scopes queries by `userId`; other users' ids are 404, not 403.
- **Credits change only through `lib/billing/ledger.ts`**, inside transactions,
  never below zero, idempotent on `{reason, refType, refId, bucket}`.
- **Prices come from `priceFor`/`quoteRequest`** on the server; the client's
  number is display only.
- **Finalize is the only path to a terminal status**; it re-fetches the status
  from the generation's own provider (webhook payloads are untrusted) and
  refunds failed/nsfw/canceled (OpenRouter: failed/expired/cancelled) once.
  Old generation documents without `platform` are Higgsfield.
- **Poll our DB, not the platform:** the browser polls
  `GET /api/generations/status`; never poll through a server action.
- **Model files cite their docs URLs**; never invent endpoints, fields or enums.
- Generating and failed tiles stay in feeds; loaded media never unmounts on fast scroll.
- Dark only; lime is reserved for the Generate CTA and active states; every
  visible control works (remove what can't); no `any`, `@ts-ignore`,
  `@ts-expect-error`.

## Definition of done for a change

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass; E2E
(`pnpm test:e2e`) passes against a running stack; docs updated when a default
or contract changes.
