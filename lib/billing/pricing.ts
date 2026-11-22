import "server-only"

import { MODELS, platformOf } from "@/generation/catalog"
import type { ModelPlatform } from "@/generation/catalog/types"
import { collections } from "@/lib/db/collections"
import { env, providersConfigured } from "@/lib/env"

import { creditConfig } from "./config"
import { fromPrice, fromQuote, toCreditTable, type CreditTable } from "./price"
import { PRICING_TABLE } from "./pricing-table"
import type { PricingTable } from "./pricing-types"

/**
 * The pricing in force: static table (placeholders, then estimate-synced
 * rules) overlaid with admin overrides from `model_pricing`, plus the set of
 * models an admin switched off. Cached briefly per process.
 *
 * Against the live platform, placeholder (unverified) rules are left out of
 * the credit table, so those endpoints can't be run until an admin prices
 * them; the local mock keeps them so every model can be exercised.
 */
export type PricingContext = {
  usd: PricingTable
  credits: CreditTable
  /** Credit rules for verified prices only (no placeholders), whatever the platform base URL. */
  verified: CreditTable
  disabled: Set<string>
  /** Models whose provider has no credentials here; hidden from the UI and refused on submit. */
  unavailable: Set<string>
  /** Placeholder rules still in use (shown as a warning in admin). */
  placeholderPaths: string[]
}

const TTL_MS = 30_000
let cached: { at: number; value: PricingContext } | undefined

export async function pricingContext(fresh = false): Promise<PricingContext> {
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value
  const usd: PricingTable = { ...PRICING_TABLE }
  const disabled = new Set<string>()
  try {
    const { modelPricing } = await collections()
    for (const doc of await modelPricing.find({}).toArray()) {
      if (!doc.enabled) disabled.add(doc.modelId)
      for (const [path, rule] of Object.entries(doc.rules ?? {}))
        usd[path] = { ...rule, source: "admin" }
    }
  } catch (error) {
    // Pricing must not take the site down when the database is unreachable.
    console.error("[pricing] could not load overrides", error)
  }
  const sellable = livePlatform()
    ? Object.fromEntries(
        Object.entries(usd).filter(([, rule]) => rule.source !== "placeholder")
      )
    : usd
  const configured = providersConfigured()
  const unavailable = new Set(
    MODELS.filter((model) => !configured[platformOf(model)]).map(
      (model) => model.id
    )
  )
  const value: PricingContext = {
    usd,
    credits: toCreditTable(sellable, creditConfig()),
    verified: toCreditTable(
      Object.fromEntries(
        Object.entries(usd).filter(([, rule]) => rule.source !== "placeholder")
      ),
      creditConfig()
    ),
    disabled,
    unavailable,
    placeholderPaths: Object.entries(usd)
      .filter(([, rule]) => rule.source === "placeholder")
      .map(([path]) => path),
  }
  cached = { at: Date.now(), value }
  return value
}

/** True when requests go to the real Higgsfield API (not the local mock). */
export function livePlatform(): boolean {
  try {
    return new URL(env().HF_API_BASE_URL).hostname.endsWith("higgsfield.ai")
  } catch {
    return false
  }
}

export function invalidatePricing(): void {
  cached = undefined
}

/** A model the signed-in (or signed-out) visitor can't run until a key is connected. */
export type InactiveModel = {
  id: string
  platform: ModelPlatform
  /** Credits of the default settings (verified prices only). */
  from: number
  reason: string
}

const PROVIDER_NAME: Record<ModelPlatform, string> = {
  higgsfield: "Higgsfield",
  openrouter: "OpenRouter",
}

/** What client pages need: credit rules (no USD) and enabled model ids. */
export type ClientPricing = {
  table: CreditTable
  /** Admin-disabled models plus those whose provider isn't usable by this visitor. */
  disabled: string[]
  /** Providers where the visitor's own key applies: runs there are billed to it, not in credits. */
  ownKeys: ModelPlatform[]
  /** Models of a provider with no key (server or the visitor's own), shown greyed with a "Connect key" nudge. */
  inactive: InactiveModel[]
  fromPrices: Record<string, number>
  /** Credits above which an OpenRouter run shows a cost warning. */
  expensiveCredits: number
  /** The "Expand prompt" button needs an OpenRouter key. */
  canExpandPrompt: boolean
}

/**
 * Pricing for one visitor. `userKeys` are the providers the visitor has
 * connected their own key for: those models are usable (and not charged in
 * credits), the rest of an unconfigured provider is "inactive".
 */
export async function clientPricing(
  userKeys: Iterable<ModelPlatform> = []
): Promise<ClientPricing> {
  const context = await pricingContext()
  const own = new Set(userKeys)
  const configured = providersConfigured()
  const usable = (platform: ModelPlatform) =>
    configured[platform] || own.has(platform)
  const fromPrices: Record<string, number> = {}
  const inactive: InactiveModel[] = []
  const unusable: string[] = []
  for (const model of MODELS) {
    const platform = platformOf(model)
    if (usable(platform)) {
      const price = fromPrice(model.id, context.credits)
      if (price !== null) fromPrices[model.id] = price
      continue
    }
    unusable.push(model.id)
    if (context.disabled.has(model.id)) continue
    // Only models with a documented or derived price are advertised.
    const quote = fromQuote(model.id, context.verified)
    if (quote)
      inactive.push({
        id: model.id,
        platform,
        from: quote.credits,
        reason: `Needs your ${PROVIDER_NAME[platform]} key`,
      })
  }
  const { OPENROUTER_WARN_USD } = env()
  const { markup, creditUsd } = creditConfig()
  return {
    table: context.credits,
    disabled: [...new Set([...context.disabled, ...unusable])],
    inactive,
    ownKeys: [...own],
    fromPrices,
    expensiveCredits: Math.ceil((OPENROUTER_WARN_USD * markup) / creditUsd),
    canExpandPrompt: configured.openrouter,
  }
}
