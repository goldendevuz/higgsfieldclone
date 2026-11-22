/**
 * Refresh lib/openrouter/models.generated.json from OpenRouter's public video
 * model list (GET /api/v1/videos/models, documented at
 * https://openrouter.ai/docs/guides/overview/multimodal/video-generation).
 * No API key is needed and nothing is billed. It keeps only the models the
 * catalog uses and only the fields pricing needs; lib/openrouter/pricing.ts
 * turns them into price rules.
 *
 *   pnpm pricing:sync:openrouter            # writes the JSON, prints USD/s
 *   pnpm pricing:sync:openrouter --dry-run  # prints only
 */
import "./load-env"

import { writeFileSync } from "node:fs"
import { join } from "node:path"

const { MODELS } = await import("../generation/catalog")
const { openRouterSlug } = await import("../generation/catalog/openrouter")
const { openRouterRules, parseModelSpecs } =
  await import("../lib/openrouter/pricing")

const base = (
  process.env.OPENROUTER_API_BASE_URL ?? "https://openrouter.ai/api/v1"
).replace(/\/$/, "")
const dryRun = process.argv.includes("--dry-run")

// The slugs the catalog actually sends (read from each model's own mapper).
const slugs = new Set<string>()
for (const model of MODELS) {
  if (model.platform !== "openrouter" || !model.toPlatform) continue
  const request = model.toPlatform({
    model: model.id,
    prompt: { text: "price preview" },
    media: {},
    settings: {},
  })
  const slug = openRouterSlug(request.path)
  if (slug) slugs.add(slug)
}

const response = await fetch(`${base}/videos/models`, {
  headers: { Accept: "application/json" },
})
if (!response.ok)
  throw new Error(`GET /videos/models failed (${response.status})`)
const listed = ((await response.json()) as { data?: Record<string, unknown>[] })
  .data
if (!Array.isArray(listed)) throw new Error("Unexpected /videos/models shape")

const kept: Record<string, unknown> = {}
for (const slug of [...slugs].sort()) {
  const entry = listed.find((item) => item.id === slug)
  if (!entry) throw new Error(`${slug} is not in /videos/models any more`)
  kept[slug] = {
    supported_resolutions: entry.supported_resolutions,
    supported_aspect_ratios: entry.supported_aspect_ratios,
    supported_sizes: entry.supported_sizes,
    supported_durations: entry.supported_durations,
    pricing_skus: entry.pricing_skus,
  }
}

const rules = openRouterRules(parseModelSpecs(kept))
for (const [path, rule] of Object.entries(rules)) {
  const perSecond = Object.entries(rule.factors?.resolution ?? {})
    .map(([name, factor]) => `${name} $${(rule.usd * factor).toFixed(4)}/s`)
    .join(" · ")
  console.log(`${path}\n  worst-case aspect ratio: ${perSecond}`)
}
if (dryRun) {
  console.log("\n(dry run: nothing written)")
} else {
  const file = join(process.cwd(), "lib", "openrouter", "models.generated.json")
  writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`)
  console.log(`\nwrote ${file}`)
}
