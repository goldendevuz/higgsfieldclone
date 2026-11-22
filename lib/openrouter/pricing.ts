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
 * Models that are not token-priced list per-second SKUs instead:
 *   duration_seconds[_with_audio|_without_audio][_<res>]   USD per second
 *   cents_per_video_output_second[_<res>] / cents_per_second_output[_<res>]   US cents per second
 *   cents_per_image_input                                   US cents per input image
 * The `duration_seconds*` names carry no unit in the docs; they are read as USD
 * (the docs' own example is `per-video-second: "0.50"`, and Veo 3.1's
 * `duration_seconds_with_audio: 0.40` is its published $0.40/s). A SKU without
 * a resolution suffix is the price of every resolution that has no SKU of its
 * own. SKUs for video input / continuation / references are never used: we
 * send none of those. The same 3% duration overshoot applies.
 *
 * Different aspect ratios have slightly different pixel counts, and `size`
 * lists them per resolution. The rule's base is the cheapest resolution at its
 * most expensive aspect; `factors` scale to the others and are rounded UP to
 * the worst case, so a price is never below the real cost. A request without
 * `aspect_ratio` ("auto") pays the worst case.
 */

const FPS = 24
const TOKEN_DIVISOR = 1024
/**
 * The first real run (Seedance 2.0 Mini, 4 s, 480p, 16:9) came back as an
 * 864×496 file of 4.096 s and was billed $0.1421, 5.6% above the listed
 * 854×480 × 4 s basis ($0.1345). So the provider bills what it renders:
 * dimensions rounded up to the next multiple of 16 above the listed size and a duration a little over the
 * request. Prices are computed on that, never below the real cost.
 */
const SIZE_ALIGN = 16
const DURATION_MARGIN = 1.03
/** Next multiple of 16 strictly above `value`: 480 renders as 496, 854 as 864. */
const alignUp = (value: number) =>
  (Math.floor(value / SIZE_ALIGN) + 1) * SIZE_ALIGN

/** One per-second SKU: USD per second, for an audio variant and resolution. */
export type SecondSku = {
  usd: number
  audio: "with" | "without" | "any"
  /** Lower-case resolution, or "default" for the SKU without a suffix. */
  resolution: string
}

export type OpenRouterModelSpec = {
  slug: string
  resolutions: string[]
  aspectRatios: string[]
  sizes: string[]
  durations: number[]
  frameImages: string[]
  /** `generate_audio` as listed: true/false, or null when the field is absent. */
  generateAudio: boolean | null
  /** USD per video token, by lower-case resolution; `default` is the fallback. Empty for per-second models. */
  tokenUsd: Record<string, number>
  /** Per-second SKUs (empty for token-priced models). */
  secondSkus: SecondSku[]
  /** USD per input image (`cents_per_image_input`), when listed. */
  imageInputUsd?: number
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

/** Short side, in pixels, each resolution name stands for. */
const NOMINAL_SHORT_SIDE: Record<string, number> = {
  "360p": 360,
  "480p": 480,
  "720p": 720,
  "768p": 768,
  "1080p": 1080,
  "1k": 1024,
  "2k": 1440,
  "4k": 2160,
}

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

/** Billed tokens per requested second: rendered (16-aligned) size plus the duration overshoot. */
export function billedTokensPerSecond(size: string): number {
  const { width, height } = parseSize(size)
  return (
    ((alignUp(width) * alignUp(height) * FPS) / TOKEN_DIVISOR) * DURATION_MARGIN
  )
}

/** Tokens generated per second of output at `size` (the listed, unaligned size). */
export function tokensPerSecond(size: string): number {
  const { width, height } = parseSize(size)
  return (width * height * FPS) / TOKEN_DIVISOR
}

const SECOND_SKU =
  /^(duration_seconds|cents_per_video_output_second|cents_per_second_output)(?:_(with_audio|without_audio))?(?:_(360p|480p|720p|768p|1080p|2k|4k))?$/

export function parseModelSpecs(raw: unknown): OpenRouterModelSpec[] {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  const numbers = (value: unknown): number[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is number =>
            typeof item === "number" && Number.isFinite(item)
        )
      : []
  return Object.entries(record(raw)).map(([slug, value]) => {
    const model = record(value)
    const skus = record(model.pricing_skus)
    const tokenUsd: Record<string, number> = {}
    const secondSkus: SecondSku[] = []
    let imageInputUsd: number | undefined
    for (const [name, price] of Object.entries(skus)) {
      const amount = Number(price)
      if (!Number.isFinite(amount) || amount <= 0) continue
      // Plain "video_tokens" and "video_tokens_<res>"; the without_audio and
      // with_video_input variants are not what we send.
      const tokens = /^video_tokens(?:_(480p|720p|1080p|4k))?$/.exec(name)
      if (tokens) {
        tokenUsd[tokens[1] ?? "default"] = amount
        continue
      }
      if (name === "cents_per_image_input") {
        imageInputUsd = amount / 100
        continue
      }
      const second = SECOND_SKU.exec(name)
      if (second)
        secondSkus.push({
          usd: second[1] === "duration_seconds" ? amount : amount / 100,
          audio:
            second[2] === "with_audio"
              ? "with"
              : second[2] === "without_audio"
                ? "without"
                : "any",
          resolution: second[3] ?? "default",
        })
    }
    if (tokenUsd.default === undefined && !secondSkus.length)
      throw new Error(`${slug}: no price we can derive in the model list`)
    return {
      slug,
      resolutions: strings(model.supported_resolutions),
      aspectRatios: strings(model.supported_aspect_ratios),
      sizes: strings(model.supported_sizes),
      durations: numbers(model.supported_durations),
      frameImages: strings(model.supported_frame_images),
      generateAudio:
        typeof model.generate_audio === "boolean" ? model.generate_audio : null,
      tokenUsd,
      secondSkus,
      ...(imageInputUsd !== undefined ? { imageInputUsd } : {}),
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
    // Sizes of a ratio that lacks some resolutions (Mini's 9:21 has only 720p,
    // Seedance 2.0's 9:21 only 720p of four) take the run of resolutions whose
    // nominal short side is nearest their own.
    let offset = resolutions.length - ranked.length
    let best = Infinity
    for (let start = 0; start + ranked.length <= resolutions.length; start++) {
      const distance = ranked.reduce((sum, { size }, index) => {
        const { width, height } = parseSize(size)
        const nominal = NOMINAL_SHORT_SIDE[resolutions[start + index]!]!
        return sum + Math.abs(Math.log(Math.min(width, height) / nominal))
      }, 0)
      if (distance <= best) {
        best = distance
        offset = start
      }
    }
    ranked.forEach(({ size }, index) => {
      const resolution = resolutions[offset + index]!
      const rate = spec.tokenUsd[resolution] ?? spec.tokenUsd.default!
      ;(grid[resolution] ??= {})[aspect] = billedTokensPerSecond(size) * rate
    })
  }
  return grid
}

/** USD per second for a resolution and audio setting from the per-second SKUs. */
function secondRate(
  spec: OpenRouterModelSpec,
  resolution: string,
  audio: boolean
): number {
  const find = (kind: SecondSku["audio"]) =>
    spec.secondSkus.find(
      (sku) => sku.audio === kind && sku.resolution === resolution
    ) ??
    spec.secondSkus.find(
      (sku) => sku.audio === kind && sku.resolution === "default"
    )
  // Audio off prefers its own SKU; with none, the with-audio (higher) price
  // stands so the price is never below the real cost.
  const order: SecondSku["audio"][] = audio
    ? ["with", "any"]
    : ["without", "any", "with"]
  for (const kind of order) {
    const sku = find(kind)
    if (sku) return sku.usd
  }
  throw new Error(`${spec.slug}: no per-second price for ${resolution}`)
}

/**
 * Per-second price rule. Resolutions price as factors of the cheapest one;
 * when audio changes the price too, a joint "resolution&generate_audio" table
 * (anchored on the dearest combination, so a request that omits either field
 * pays the worst case) keeps every combination exact instead of multiplying
 * two independent factors.
 */
function perSecondRule(spec: OpenRouterModelSpec): PriceRule {
  const margin = (usd: number) => usd * DURATION_MARGIN
  const names = spec.resolutions.map((name) => name.toLowerCase())
  if (!names.length) throw new Error(`${spec.slug}: no resolutions listed`)
  const on = Object.fromEntries(
    names.map((name) => [name, secondRate(spec, name, true)])
  )
  const off = Object.fromEntries(
    names.map((name) => [name, secondRate(spec, name, false)])
  )
  const audioMatters = names.some((name) => on[name] !== off[name])
  const extras = spec.imageInputUsd
    ? {
        perItem: {
          role: "start" as const,
          included: 0,
          usd: Math.ceil(spec.imageInputUsd * 1e6) / 1e6,
        },
      }
    : {}
  if (audioMatters) {
    const rates = names.flatMap((name) => [on[name]!, off[name]!])
    const top = Math.max(...rates)
    const joint: Record<string, number> = {}
    spec.resolutions.forEach((spelled, index) => {
      const name = names[index]!
      joint[`${spelled}|true`] = Math.ceil((on[name]! / top) * 1e6) / 1e6
      joint[`${spelled}|false`] = Math.ceil((off[name]! / top) * 1e6) / 1e6
    })
    return {
      usd: Math.ceil(margin(top) * 1e6) / 1e6,
      per: "second",
      field: "duration",
      factors: { "resolution&generate_audio": joint },
      source: "openrouter",
      ...extras,
    }
  }
  const base = Math.min(...names.map((name) => on[name]!))
  const resolution: Record<string, number> = {}
  spec.resolutions.forEach((spelled, index) => {
    resolution[spelled] = Math.ceil((on[names[index]!]! / base) * 1e6) / 1e6
  })
  return {
    usd: Math.ceil(margin(base) * 1e6) / 1e6,
    per: "second",
    field: "duration",
    factors: { resolution },
    source: "openrouter",
    ...extras,
  }
}

/** One price rule per model: base × resolution factor × aspect-ratio factor. */
export function openRouterRule(spec: OpenRouterModelSpec): PriceRule {
  if (spec.tokenUsd.default === undefined) return perSecondRule(spec)
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
  if (spec.tokenUsd.default === undefined) return rule
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
