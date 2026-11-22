import type { PriceRule, PricingTable } from "@/lib/billing/pricing-types"

import generated from "./models.generated.json"

/**
 * OpenRouter USD cost per video model, derived from its public model list
 * (`GET /api/v1/videos/models`, refreshed by `pnpm pricing:sync:openrouter`).
 *
 * OpenRouter lists a price per *video token* (`pricing_skus.video_tokens`,
 * plus `video_tokens_1080p` etc. where a resolution differs). Seedance bills
 * tokens = width × height × seconds × 24 / 1024 (the formula Higgsfield's docs
 * quote for the same models). Checked against the figures we were given:
 * Seedance 2.5 = 854×480×24/1024 × $0.0000107 = $0.1028/s at 480p and
 * 1280×720 → $0.2311/s at 720p. The formula is an assumption for OpenRouter
 * itself: the first real run's `usage.cost` is logged against what we charged
 * (lib/generations/finalize.ts) so a mismatch is visible immediately.
 *
 * Pricing is by generated second with no video input (we offer no video
 * references; with video input OpenRouter bills input seconds too).
 *
 * Different aspect ratios have slightly different pixel counts, and `size`
 * lists them per resolution. The rule's base is the cheapest resolution at its
 * most expensive aspect; `factors` scale to the others and are rounded UP to
 * the worst case, so a price is never below the real cost. A request without
 * `aspect_ratio` ("auto") pays the worst case.
 */

const FPS = 24
const TOKEN_DIVISOR = 1024

export type OpenRouterModelSpec = {
  slug: string
  resolutions: string[]
  aspectRatios: string[]
  sizes: string[]
  /** USD per video token, by lower-case resolution; `default` is the fallback. */
  tokenUsd: Record<string, number>
}

/** Resolutions in ascending order of size (their relative order is all we use). */
const RESOLUTION_ORDER = [
  "360p",
  "480p",
  "720p",
  "768p",
  "1080p",
  "1k",
  "2k",
  "4k",
]

function parseSize(size: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) throw new Error(`Unexpected size "${size}"`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

function nearest(value: number, options: Record<string, number>): string {
  let best = ""
  let bestDistance = Infinity
  for (const [key, option] of Object.entries(options)) {
    const distance = Math.abs(Math.log(value / option))
    if (distance < bestDistance) {
      best = key
      bestDistance = distance
    }
  }
  return best
}

function ratioValue(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number)
  return w! / h!
}

function pixelsOf(size: string): number {
  const { width, height } = parseSize(size)
  return width * height
}

/** Tokens generated per second of output at `size`. */
export function tokensPerSecond(size: string): number {
  const { width, height } = parseSize(size)
  return (width * height * FPS) / TOKEN_DIVISOR
}

export function parseModelSpecs(raw: unknown): OpenRouterModelSpec[] {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  return Object.entries(record(raw)).map(([slug, value]) => {
    const model = record(value)
    const skus = record(model.pricing_skus)
    const tokenUsd: Record<string, number> = {}
    for (const [name, price] of Object.entries(skus)) {
      // Plain "video_tokens" and "video_tokens_<res>"; the without_audio and
      // with_video_input variants are not what we send.
      const match = /^video_tokens(?:_(480p|720p|1080p|4k))?$/.exec(name)
      const usd = Number(price)
      if (match && Number.isFinite(usd) && usd > 0)
        tokenUsd[match[1] ?? "default"] = usd
    }
    if (tokenUsd.default === undefined)
      throw new Error(`${slug}: no video_tokens price in the model list`)
    return {
      slug,
      resolutions: strings(model.supported_resolutions),
      aspectRatios: strings(model.supported_aspect_ratios),
      sizes: strings(model.supported_sizes),
      tokenUsd,
    }
  })
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/**
 * USD per second of output for every (resolution, aspect) the model lists.
 * `supported_sizes` carries no labels, and sizes are not a clean function of
 * the resolution name (Seedance's "1080p" square is 1080×1080, its 480p square
 * 640×640). So each size takes its aspect ratio from its shape and its
 * resolution from its rank among the sizes of that ratio, smallest first;
 * a ratio that lacks the smallest resolutions (Mini's 9:21 has only 720p)
 * aligns to the largest.
 */
export function perSecondGrid(
  spec: OpenRouterModelSpec
): Record<string, Record<string, number>> {
  const resolutions = spec.resolutions
    .map((name) => name.toLowerCase())
    .sort((a, b) => RESOLUTION_ORDER.indexOf(a) - RESOLUTION_ORDER.indexOf(b))
  if (resolutions.some((name) => !RESOLUTION_ORDER.includes(name)))
    throw new Error(`${spec.slug}: unknown resolution in ${resolutions}`)
  const ratios = Object.fromEntries(
    spec.aspectRatios.map((aspect) => [aspect, ratioValue(aspect)])
  )
  const byAspect: Record<string, string[]> = {}
  for (const size of spec.sizes) {
    const { width, height } = parseSize(size)
    ;(byAspect[nearest(width / height, ratios)] ??= []).push(size)
  }
  const grid: Record<string, Record<string, number>> = {}
  for (const [aspect, sizes] of Object.entries(byAspect)) {
    const ranked = sizes
      .map((size) => ({ size, pixels: pixelsOf(size) }))
      .sort((a, b) => a.pixels - b.pixels)
    if (ranked.length > resolutions.length)
      throw new Error(`${spec.slug}: more ${aspect} sizes than resolutions`)
    const offset = resolutions.length - ranked.length
    ranked.forEach(({ size }, index) => {
      const resolution = resolutions[offset + index]!
      const rate = spec.tokenUsd[resolution] ?? spec.tokenUsd.default!
      ;(grid[resolution] ??= {})[aspect] = tokensPerSecond(size) * rate
    })
  }
  return grid
}

/** One price rule per model: base × resolution factor × aspect-ratio factor. */
export function openRouterRule(spec: OpenRouterModelSpec): PriceRule {
  const grid = perSecondGrid(spec)
  const resolutions = spec.resolutions
    .map((name) => name.toLowerCase())
    .filter((name) => grid[name])
  if (!resolutions.length) throw new Error(`${spec.slug}: no priced sizes`)
  const worst = (resolution: string) =>
    Math.max(...Object.values(grid[resolution]!))
  const cheapest = resolutions.reduce((a, b) => (worst(a) <= worst(b) ? a : b))
  const base = worst(cheapest)
  const resolutionFactor: Record<string, number> = {}
  for (const name of resolutions)
    resolutionFactor[name] = round6(worst(name) / base)
  const aspectFactor: Record<string, number> = {}
  for (const aspect of spec.aspectRatios) {
    // Highest share of that resolution's worst case, across resolutions.
    let share = 0
    for (const name of resolutions) {
      const usd = grid[name]![aspect]
      if (usd !== undefined) share = Math.max(share, usd / worst(name))
    }
    if (share > 0) aspectFactor[aspect] = Math.ceil(share * 1e6) / 1e6
  }
  return {
    usd: Math.ceil(base * 1e6) / 1e6,
    per: "second",
    // The mapper always sends integer seconds in `duration`.
    field: "duration",
    factors: { resolution: resolutionFactor, aspect_ratio: aspectFactor },
    source: "openrouter",
  }
}

/** Resolution factors are keyed by the exact value the request carries ("480p", "1080p", "4K"). */
function withRequestSpelling(
  spec: OpenRouterModelSpec,
  rule: PriceRule
): PriceRule {
  const factors = rule.factors?.resolution ?? {}
  const spelled: Record<string, number> = {}
  for (const name of spec.resolutions) {
    const factor = factors[name.toLowerCase()]
    if (factor !== undefined) spelled[name] = factor
  }
  return {
    ...rule,
    factors: { ...rule.factors, resolution: spelled },
  }
}

export function openRouterRules(specs: OpenRouterModelSpec[]): PricingTable {
  return Object.fromEntries(
    specs.map((spec) => [
      `openrouter/${spec.slug}`,
      withRequestSpelling(spec, openRouterRule(spec)),
    ])
  )
}

/** Price rules for every OpenRouter model in the checked-in model list. */
export const OPENROUTER_PRICING: PricingTable = openRouterRules(
  parseModelSpecs(generated)
)
