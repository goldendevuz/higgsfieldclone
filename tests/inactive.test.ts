import { describe, expect, it } from "vitest"

import { setupEnv } from "./support/harness"

setupEnv()
delete process.env.HF_CREDENTIALS
delete process.env.OPENROUTER_API_KEY

const { findModel, MODELS, platformOf } = await import("@/generation/catalog")
const { fromQuote } = await import("@/lib/billing/price")
const { clientPricing, invalidatePricing, pricingContext } =
  await import("@/lib/billing/pricing")
const { PRICING_TABLE } = await import("@/lib/billing/pricing-table")
const { resetEnvForTests } = await import("@/lib/env")

async function pricing(userKeys: ("higgsfield" | "openrouter")[] = []) {
  resetEnvForTests()
  invalidatePricing()
  return clientPricing(userKeys)
}

describe("inactive models (a provider with no usable key)", () => {
  it("lists the models of both providers, with reasons, and hides them from the selectable set", async () => {
    const { inactive, disabled } = await pricing()
    const platforms = new Set(inactive.map((item) => item.platform))
    expect(platforms).toEqual(new Set(["higgsfield", "openrouter"]))
    for (const item of inactive) {
      expect(disabled).toContain(item.id)
      expect(item.from).toBeGreaterThanOrEqual(1)
      expect(item.reason).toBe(
        item.platform === "openrouter"
          ? "Needs your OpenRouter key"
          : "Needs your Higgsfield key"
      )
    }
    // Every OpenRouter model is priced from its list, so all are advertised.
    const openrouter = MODELS.filter((m) => platformOf(m) === "openrouter")
    expect(
      inactive.filter((item) => item.platform === "openrouter").length
    ).toBe(openrouter.length)
  })

  it("never advertises a Higgsfield model whose price is a placeholder", async () => {
    const { inactive } = await pricing()
    const context = await pricingContext()
    let placeholders = 0
    for (const model of MODELS.filter((m) => platformOf(m) === "higgsfield")) {
      const quote = fromQuote(
        model.id,
        // The same table clientPricing uses for the section.
        context.verified
      )
      const listed = inactive.some((item) => item.id === model.id)
      expect(listed, model.id).toBe(Boolean(quote))
      // The unfiltered table may still price it (mock mode), never as verified.
      for (const entry of inactive.filter((item) => item.id === model.id)) {
        const full = fromQuote(entry.id, context.credits)
        if (full)
          expect(PRICING_TABLE[full.path]?.source).not.toBe("placeholder")
      }
      if (!quote) placeholders++
    }
    expect(placeholders).toBeGreaterThan(0)
  })

  it("an own key makes that provider's models selectable and removes them from the inactive list", async () => {
    const { inactive, disabled } = await pricing(["openrouter"])
    expect(inactive.some((item) => item.platform === "openrouter")).toBe(false)
    const orIds = MODELS.filter((m) => platformOf(m) === "openrouter").map(
      (m) => m.id
    )
    for (const id of orIds) expect(disabled).not.toContain(id)
    expect(inactive.some((item) => item.platform === "higgsfield")).toBe(true)
    expect(findModel("seedance-2.5-openrouter")).toBeDefined()
  })
})
