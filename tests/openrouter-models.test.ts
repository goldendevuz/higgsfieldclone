import { describe, expect, it } from "vitest"

import { setupEnv } from "./support/harness"

setupEnv()

const { getModel, MODELS, parseSettings } = await import("@/generation/catalog")
const { groupMedia, inferInputMode } =
  await import("@/generation/catalog/media-inputs")
const { OPENROUTER_VIDEO_SPECS } =
  await import("@/generation/catalog/models/openrouter-video")
const { toPlatform } = await import("@/generation/to-platform")
const { usdForRequest, factorFor } = await import("@/lib/billing/price")
const generated = (await import("@/lib/openrouter/models.generated.json"))
  .default as Record<string, Record<string, unknown>>
const { OPENROUTER_PRICING, parseModelSpecs } =
  await import("@/lib/openrouter/pricing")

type Media = Parameters<typeof groupMedia>[0]

function request(
  modelId: string,
  settings: Record<string, unknown> = {},
  media: Media = []
) {
  const model = getModel(modelId)
  return toPlatform({
    model: modelId,
    inputMode: inferInputMode(model, media),
    prompt: { text: "A fox crossing a snowy field" },
    media: groupMedia(media),
    settings: parseSettings(model, settings),
  })
}

function usd(
  modelId: string,
  settings: Record<string, unknown> = {},
  media: Media = []
) {
  const req = request(modelId, settings, media)
  const rule = OPENROUTER_PRICING[req.path]
  expect(rule, `${modelId} has a price rule`).toBeDefined()
  return usdForRequest(rule!, req, media)
}

const specs = new Map(parseModelSpecs(generated).map((s) => [s.slug, s]))
const MARGIN = 1.03

describe("OpenRouter video catalog matches the model list", () => {
  for (const spec of OPENROUTER_VIDEO_SPECS) {
    describe(spec.id, () => {
      const listed = specs.get(spec.slug)

      it("is in the checked-in list and priced", () => {
        expect(listed).toBeDefined()
        expect(OPENROUTER_PRICING[`openrouter/${spec.slug}`]).toBeDefined()
      })

      it("uses the listed resolutions, ratios, durations and frames", () => {
        expect([...spec.resolutions].sort()).toEqual(
          [...listed!.resolutions].sort()
        )
        expect([...spec.aspects].sort()).toEqual(
          [...listed!.aspectRatios].sort()
        )
        expect(spec.durations).toEqual(
          listed!.durations.filter((value) => value > 0).sort((a, b) => a - b)
        )
        expect(spec.frames === "first-last").toBe(
          listed!.frameImages.includes("last_frame")
        )
        expect(listed!.frameImages).toContain("first_frame")
        // A toggle only where the list says the model takes generate_audio.
        if (spec.audioToggle) expect(listed!.generateAudio).toBe(true)
      })

      it("defaults to the cheapest resolution", () => {
        const costs = spec.resolutions.map((resolution) => ({
          resolution,
          usd: usd(
            spec.id,
            spec.fixedResolution ? {} : { resolution },
            spec.requireStart
              ? [{ id: "s", role: "start", url: "https://x.test/a.png" }]
              : []
          ),
        }))
        const cheapest = Math.min(...costs.map((cost) => cost.usd))
        const chosen = costs.find(
          (cost) => cost.resolution === spec.defaultResolution
        )!
        expect(chosen.usd).toBeCloseTo(cheapest, 6)
      })
    })
  }
})

describe("per-second price shapes", () => {
  it("flat per-resolution SKUs (Wan 3.0): $0.05/s at 480p, 4 s, plus the duration margin", () => {
    expect(usd("wan-3-openrouter")).toBeCloseTo(0.05 * 4 * MARGIN, 4)
    expect(
      usd("wan-3-openrouter", { resolution: "1080p", duration: 10 })
    ).toBeCloseTo(0.2 * 10 * MARGIN, 4)
    // Audio has no SKU of its own, so the toggle does not change the price.
    expect(usd("wan-3-openrouter", { generateAudio: false })).toBe(
      usd("wan-3-openrouter")
    )
  })

  it("a single flat SKU (Hailuo 2.3, 1080p fixed) sends its resolution", () => {
    const req = request("hailuo-2.3-openrouter")
    expect(req.body.resolution).toBe("1080p")
    expect(usd("hailuo-2.3-openrouter", { duration: "10" })).toBeCloseTo(
      0.0817 * 10 * MARGIN,
      4
    )
  })

  it("joint resolution × audio table (Veo 3.1): each combination is its own SKU", () => {
    const at = (settings: Record<string, unknown>) =>
      usd("veo-3.1-openrouter", { duration: "8", ...settings })
    expect(at({ resolution: "720p" })).toBeCloseTo(0.4 * 8 * MARGIN, 4)
    expect(at({ resolution: "1080p", generateAudio: false })).toBeCloseTo(
      0.2 * 8 * MARGIN,
      4
    )
    expect(at({ resolution: "4K" })).toBeCloseTo(0.6 * 8 * MARGIN, 4)
    expect(at({ resolution: "4K", generateAudio: false })).toBeCloseTo(
      0.4 * 8 * MARGIN,
      4
    )
    // Veo 3.1 Fast has its own 720p SKUs: $0.10 with audio, $0.08 without.
    expect(
      usd("veo-3.1-fast-openrouter", { duration: "8", generateAudio: false })
    ).toBeCloseTo(0.08 * 8 * MARGIN, 4)
    // A body that omits either field pays the dearest combination.
    const rule = OPENROUTER_PRICING["openrouter/google/veo-3.1"]!
    expect(factorFor(rule, { resolution: "720p" })).toBe(1)
    expect(rule.usd).toBeCloseTo(0.6 * MARGIN, 4)
  })

  it("never prices a joint combination below its SKU", () => {
    for (const [slug, id] of [
      ["google/veo-3.1", "veo-3.1-openrouter"],
      ["google/veo-3.1-fast", "veo-3.1-fast-openrouter"],
      ["google/veo-3.1-lite", "veo-3.1-lite-openrouter"],
    ]) {
      const listed = specs.get(slug!)!
      const find = (audio: string, resolution: string) =>
        listed.secondSkus.find(
          (sku) => sku.audio === audio && sku.resolution === resolution
        ) ??
        listed.secondSkus.find(
          (sku) => sku.audio === audio && sku.resolution === "default"
        )!
      for (const resolution of listed.resolutions)
        for (const audio of [true, false]) {
          const sku = find(audio ? "with" : "without", resolution.toLowerCase())
          expect(
            usd(id!, { duration: "4", resolution, generateAudio: audio })
          ).toBeGreaterThanOrEqual(sku.usd * 4 - 1e-9)
        }
    }
  })

  it("cents SKUs plus a per-input-image fee (Grok Imagine 1.5)", () => {
    expect(usd("grok-imagine-video-1.5-openrouter")).toBeCloseTo(
      0.08 * 4 * MARGIN,
      4
    )
    // One start frame adds cents_per_image_input = 1 cent.
    const withFrame = usd("grok-imagine-video-1.5-openrouter", {}, [
      { id: "s", role: "start", url: "https://x.test/a.png" },
    ])
    expect(withFrame).toBeCloseTo(0.08 * 4 * MARGIN + 0.01, 4)
    expect(
      usd("grok-imagine-video-1.5-lite-openrouter", { resolution: "1080p" })
    ).toBeCloseTo(0.14 * 4 * MARGIN, 4)
  })

  it("a SKU without suffix prices the resolutions that have none (Gemini Omni 1080p)", () => {
    expect(
      usd("gemini-omni-1.2-flash-openrouter", { resolution: "1080p" })
    ).toBeCloseTo(0.104256 * 4 * MARGIN, 4)
    expect(usd("gemini-omni-1.2-flash-openrouter")).toBeCloseTo(
      0.023172 * 4 * MARGIN,
      4
    )
  })

  it("two-tier cents (Mischief) and Flux 3 Video", () => {
    const start: Media = [
      { id: "s", role: "start", url: "https://x.test/a.png" },
    ]
    expect(usd("mischief-1-openrouter", { duration: "5" }, start)).toBeCloseTo(
      0.005 * 5 * MARGIN,
      5
    )
    expect(
      usd("flux-3-video-openrouter", { resolution: "4K", duration: 5 })
    ).toBeCloseTo(0.41 * 5 * MARGIN, 4)
  })

  it("token pricing still carries the rendered-size margin (Seedance 2.0 Fast)", () => {
    // 480p worst-case aspect is above the plain 854×480 basis.
    const plain = ((854 * 480 * 24) / 1024) * 0.0000056 * 4
    expect(usd("seedance-2.0-fast-openrouter")).toBeGreaterThan(plain * 1.05)
    expect(usd("seedance-2.0-fast-openrouter")).toBeLessThan(plain * 1.6)
    // 4K exists on Seedance 2.0 and is priced with its own, lower, token rate.
    expect(
      usd("seedance-2.0-openrouter", { resolution: "4K", duration: 4 })
    ).toBeGreaterThan(((3840 * 2160 * 24) / 1024) * 0.000004 * 4)
  })
})

describe("models deliberately not wired", () => {
  it("lists no HeyGen, edit or upscale models", () => {
    const slugs = MODELS.flatMap((model) =>
      model.platform === "openrouter"
        ? [
            toPlatform({
              model: model.id,
              prompt: { text: "x" },
              media: model.requiredRoles?.includes("start")
                ? {
                    start: [
                      { id: "s", role: "start", url: "https://x.test/a.png" },
                    ],
                  }
                : {},
              settings: parseSettings(model, {}),
            }).path,
          ]
        : []
    )
    for (const skipped of [
      "heygen",
      "flux-video-edit",
      "flux-video-upscale",
      "aleph",
    ])
      expect(slugs.some((path) => path.includes(skipped))).toBe(false)
  })
})
