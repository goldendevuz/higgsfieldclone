import { afterEach, describe, expect, it, vi } from "vitest"

import {
  FakeOpenRouter,
  OR_BASE,
  OR_KEY,
  setupEnv,
  tinyPng,
} from "./support/harness"

setupEnv()

const { getModel, parseSettings } = await import("@/generation/catalog")
const { groupMedia, inferInputMode } =
  await import("@/generation/catalog/media-inputs")
const { toPlatform } = await import("@/generation/to-platform")
const { creditsFromUsd, priceFor, toCreditTable, usdForRequest } =
  await import("@/lib/billing/price")
const { AmbiguousSubmitError } = await import("@/lib/higgsfield/client")
const { createOpenRouterClient, mapJob, mapJobStatus, OpenRouterError } =
  await import("@/lib/openrouter/client")
const { InlineMediaError, withSendableMedia, MAX_INLINE_IMAGE_BYTES } =
  await import("@/lib/openrouter/media")
const generated = (await import("@/lib/openrouter/models.generated.json"))
  .default
const { OPENROUTER_PRICING, parseModelSpecs, perSecondGrid, tokensPerSecond } =
  await import("@/lib/openrouter/pricing")
const {
  openRouterCallbackUrlFor,
  openRouterWebhookToken,
  verifyOpenRouterWebhookToken,
} = await import("@/lib/openrouter/webhook")
const { webhookToken } = await import("@/lib/higgsfield/webhook")
const { resetEnvForTests, env, providersConfigured } = await import("@/lib/env")

type Media = Parameters<typeof groupMedia>[0]

function request(
  modelId: string,
  media: Media = [],
  settings: Record<string, unknown> = {},
  prompt = "A fox crossing a snowy field"
) {
  const model = getModel(modelId)
  return toPlatform({
    model: modelId,
    inputMode: inferInputMode(model, media),
    prompt: { text: prompt },
    media: groupMedia(media),
    settings: parseSettings(model, settings),
  })
}

const item = (role: Media[number]["role"], n: number): Media[number] => ({
  id: `${role}${n}`,
  role,
  url: `https://media.example.com/${role}${n}.png`,
})

/* ── Request mapper ──────────────────────────────────────────────────────── */

describe("OpenRouter request mapper", () => {
  it("text: prompt, 480p, 4 s, no media fields", () => {
    const { path, body } = request("seedance-2.5-openrouter")
    expect(path).toBe("openrouter/bytedance/seedance-2.5")
    expect(body).toEqual({
      model: "bytedance/seedance-2.5",
      prompt: "A fox crossing a snowy field",
      duration: 4,
      resolution: "480p",
      aspect_ratio: "16:9",
      generate_audio: true,
    })
  })

  it("frames: first and last frame images with their frame_type", () => {
    const { body } = request("seedance-2.5-openrouter", [
      item("start", 1),
      item("end", 1),
    ])
    expect(body.frame_images).toEqual([
      {
        type: "image_url",
        image_url: { url: "https://media.example.com/start1.png" },
        frame_type: "first_frame",
      },
      {
        type: "image_url",
        image_url: { url: "https://media.example.com/end1.png" },
        frame_type: "last_frame",
      },
    ])
    expect(body).not.toHaveProperty("input_references")
  })

  it("references: input_references, never frame_images", () => {
    const { body } = request("seedance-2.0-mini-openrouter", [
      item("reference", 1),
      item("reference", 2),
    ])
    expect(body.input_references).toEqual([
      {
        type: "image_url",
        image_url: { url: "https://media.example.com/reference1.png" },
      },
      {
        type: "image_url",
        image_url: { url: "https://media.example.com/reference2.png" },
      },
    ])
    expect(body).not.toHaveProperty("frame_images")
  })

  it("auto aspect omits aspect_ratio; an image alone needs no prompt", () => {
    const { body } = request(
      "seedance-2.5-openrouter",
      [item("start", 1)],
      { aspectRatio: "auto" },
      ""
    )
    expect(body).not.toHaveProperty("aspect_ratio")
    expect(body).not.toHaveProperty("prompt")
  })

  it("rejects frames mixed with references, an end frame alone, and nothing", () => {
    expect(() =>
      request("seedance-2.5-openrouter", [
        item("start", 1),
        item("reference", 1),
      ])
    ).toThrow()
    expect(() => request("seedance-2.5-openrouter", [item("end", 1)])).toThrow()
    expect(() => request("seedance-2.5-openrouter", [], {}, "")).toThrow(
      /prompt|start frame/i
    )
  })

  it("only offers documented values", () => {
    const mini = getModel("seedance-2.0-mini-openrouter")
    expect(() => parseSettings(mini, { duration: 16 })).toThrow()
    expect(() => parseSettings(mini, { resolution: "1080p" })).toThrow()
    const full = getModel("seedance-2.5-openrouter")
    expect(
      parseSettings(full, { duration: 30, resolution: "1080p" })
    ).toBeTruthy()
    expect(() => parseSettings(full, { duration: 31 })).toThrow()
  })

  it("defaults to the cheap choice: 480p, 4 s", () => {
    for (const id of [
      "seedance-2.5-openrouter",
      "seedance-2.0-mini-openrouter",
    ]) {
      const settings = parseSettings(getModel(id), {})
      expect(settings.resolution).toBe("480p")
      expect(settings.duration).toBe(4)
    }
  })
})

/* ── Pricing ─────────────────────────────────────────────────────────────── */

describe("OpenRouter pricing", () => {
  const specs = parseModelSpecs(generated)
  const spec = (slug: string) => specs.find((item) => item.slug === slug)!

  it("starts from the listed per-second figures (Seedance 2.5) and adds the billing overshoot", () => {
    const grid = perSecondGrid(spec("bytedance/seedance-2.5"))
    // Listed basis: $0.1028/s (854x480) and $0.2311/s (1280x720); billed sizes
    // are 16-aligned (864x496) with 3% duration overshoot, so never lower.
    expect(grid["480p"]!["16:9"]).toBeGreaterThan(0.1028)
    expect(grid["480p"]!["16:9"]).toBeLessThan(0.1028 * 1.1)
    expect(grid["720p"]!["16:9"]).toBeGreaterThanOrEqual(0.2311)
    expect(grid["720p"]!["16:9"]).toBeLessThan(0.2311 * 1.1)
    expect(tokensPerSecond("854x480")).toBeCloseTo(9_607.5, 1)
  })

  it("covers the first real Mini run (4 s, 480p, 16:9 billed $0.1421)", () => {
    const rule = OPENROUTER_PRICING["openrouter/bytedance/seedance-2.0-mini"]!
    const usd =
      rule.usd *
      4 *
      (rule.factors?.resolution?.["480p"] ?? 1) *
      (rule.factors?.aspect_ratio?.["16:9"] ?? 1)
    expect(usd).toBeGreaterThanOrEqual(0.1421)
    expect(usd).toBeLessThan(0.1421 * 1.1)
  })

  it("derives Mini from its own price list ($0.0000035 per token)", () => {
    const grid = perSecondGrid(spec("bytedance/seedance-2.0-mini"))
    expect(grid["480p"]!["16:9"]).toBeGreaterThan(0.0336)
    // Mini's 9:21 exists only at 720p (no 480x1120 size is listed).
    expect(grid["480p"]!["9:21"]).toBeUndefined()
    expect(grid["720p"]!["9:21"]).toBeDefined()
  })

  it("never prices a (resolution, aspect) below its real cost", () => {
    for (const item of specs.filter((spec) => spec.tokenUsd.default)) {
      const rule = OPENROUTER_PRICING[`openrouter/${item.slug}`]!
      const grid = perSecondGrid(item)
      for (const [resolution, row] of Object.entries(grid))
        for (const [aspect, real] of Object.entries(row)) {
          const charged =
            rule.usd *
            (rule.factors!.resolution![resolution] ??
              rule.factors!.resolution![resolution.toUpperCase()]!) *
            rule.factors!.aspect_ratio![aspect]!
          expect(
            charged,
            `${item.slug} ${resolution} ${aspect}`
          ).toBeGreaterThanOrEqual(real - 1e-9)
        }
    }
  })

  it("prices a 4 s 480p Seedance 2.5 clip at or just above $0.41 and a 15 s one above $1.54", () => {
    const table = toCreditTable(OPENROUTER_PRICING, {
      markup: 2,
      creditUsd: 0.01,
    })
    const usdOf = (modelId: string, settings: Record<string, unknown>) => {
      const req = request(modelId, [], settings)
      return usdForRequest(OPENROUTER_PRICING[req.path]!, req, [])
    }
    expect(usdOf("seedance-2.5-openrouter", {})).toBeGreaterThanOrEqual(0.4112)
    expect(usdOf("seedance-2.5-openrouter", {})).toBeLessThan(0.48)
    expect(usdOf("seedance-2.5-openrouter", { duration: 15 })).toBeGreaterThan(
      1.54
    )
    expect(usdOf("seedance-2.5-openrouter", { duration: 15 })).toBeLessThan(
      1.75
    )
    // Credits = ceil(usd × markup / credit value), exactly the existing formula.
    const quote = priceFor("seedance-2.5-openrouter", {}, [], table)
    expect(quote.credits).toBe(
      creditsFromUsd(usdOf("seedance-2.5-openrouter", {}), {
        markup: 2,
        creditUsd: 0.01,
      })
    )
  })

  it("the cost warning (default $0.75, 150 credits at 2x) skips a 4 s draft and catches long or HD runs", () => {
    const table = toCreditTable(OPENROUTER_PRICING, {
      markup: 2,
      creditUsd: 0.01,
    })
    const threshold = Math.ceil((0.75 * 2) / 0.01)
    const credits = (id: string, settings: Record<string, unknown>) =>
      priceFor(id, settings, [], table).credits
    expect(credits("seedance-2.5-openrouter", {})).toBeLessThan(threshold)
    expect(credits("seedance-2.0-mini-openrouter", {})).toBeLessThan(threshold)
    expect(
      credits("seedance-2.5-openrouter", { duration: 10 })
    ).toBeGreaterThanOrEqual(threshold)
    expect(
      credits("seedance-2.5-openrouter", { resolution: "720p" })
    ).toBeGreaterThanOrEqual(threshold)
  })

  it("720p costs about 2.2x and Mini 480p is the cheapest option", () => {
    const usd = (id: string, settings: Record<string, unknown>) => {
      const req = request(id, [], settings)
      return usdForRequest(OPENROUTER_PRICING[req.path]!, req, [])
    }
    const base = usd("seedance-2.5-openrouter", {})
    const hd = usd("seedance-2.5-openrouter", { resolution: "720p" })
    expect(hd / base).toBeGreaterThan(2.1)
    expect(hd / base).toBeLessThan(2.4)
    expect(usd("seedance-2.0-mini-openrouter", {})).toBeLessThan(base / 2)
  })

  it("charges the worst case when the aspect ratio is left to the model", () => {
    const fixed = request("seedance-2.0-mini-openrouter", [], {
      aspectRatio: "16:9",
    })
    const auto = request("seedance-2.0-mini-openrouter", [], {
      aspectRatio: "auto",
    })
    const rule = OPENROUTER_PRICING[fixed.path]!
    expect(usdForRequest(rule, auto, [])).toBeGreaterThan(
      usdForRequest(rule, fixed, [])
    )
  })
})

/* ── Client ──────────────────────────────────────────────────────────────── */

function clientWith(fake: FakeOpenRouter) {
  return createOpenRouterClient({
    apiKey: OR_KEY,
    baseUrl: OR_BASE,
    fetch: fake.fetch,
    sleep: async () => undefined,
  })
}

describe("OpenRouter client", () => {
  const body = { model: "bytedance/seedance-2.5", prompt: "x", duration: 4 }

  it("submits with Bearer auth, JSON, and the callback URL", async () => {
    const fake = new FakeOpenRouter()
    const job = await clientWith(fake).submit(
      body,
      "https://vireo.test/cb?gid=1"
    )
    expect(job.id).toMatch(/^gen-vid-/)
    expect(job.status).toBe("pending")
    expect(fake.submits).toHaveLength(1)
    expect(fake.submits[0]!.authorization).toBe(`Bearer ${OR_KEY}`)
    expect(fake.submits[0]!.body).toMatchObject({
      ...body,
      callback_url: "https://vireo.test/cb?gid=1",
    })
  })

  it("retries a 429 on submit (nothing was created) with backoff", async () => {
    const calls: number[] = []
    const responses = [429, 503, 202]
    const client = createOpenRouterClient({
      apiKey: OR_KEY,
      baseUrl: OR_BASE,
      sleep: async (ms) => void calls.push(ms),
      fetch: async () => {
        const status = responses.shift()!
        return new Response(
          JSON.stringify(
            status === 202
              ? {
                  id: "gen-vid-1-abcdefghijklmnopqrst",
                  status: "pending",
                  polling_url: "x",
                }
              : { error: { code: status, message: "slow down" } }
          ),
          { status }
        )
      },
    })
    expect((await client.submit(body)).id).toBe(
      "gen-vid-1-abcdefghijklmnopqrst"
    )
    expect(calls).toHaveLength(2) // two waits, jittered
    expect(calls.every((ms) => ms >= 0 && ms <= 400 * 4)).toBe(true)
  })

  it("never retries an ambiguous submit: network error, 500, 502, 504", async () => {
    for (const failure of ["network", 500, 502, 504] as const) {
      const fake = new FakeOpenRouter()
      fake.nextSubmit = failure
      await expect(clientWith(fake).submit(body)).rejects.toBeInstanceOf(
        AmbiguousSubmitError
      )
      // One attempt only: a retry could create (and bill) a second video.
      expect(fake.seen.filter((r) => r.method === "POST")).toHaveLength(1)
    }
  })

  it("treats a 2xx without a job id as ambiguous, not as success", async () => {
    const client = createOpenRouterClient({
      apiKey: OR_KEY,
      baseUrl: OR_BASE,
      sleep: async () => undefined,
      fetch: async () => new Response("{}", { status: 202 }),
    })
    await expect(client.submit(body)).rejects.toBeInstanceOf(
      AmbiguousSubmitError
    )
  })

  it("does not retry definite rejections (400, 401, 402, 403, 404, 413)", async () => {
    for (const status of [400, 401, 402, 403, 404, 413]) {
      const fake = new FakeOpenRouter()
      fake.nextSubmit = status
      const caught = await clientWith(fake)
        .submit(body)
        .catch((error: unknown) => error)
      expect(caught).toBeInstanceOf(OpenRouterError)
      expect((caught as InstanceType<typeof OpenRouterError>).status).toBe(
        status
      )
      expect(fake.seen).toHaveLength(1)
    }
  })

  it("retries safe calls: status polls survive a 502 and a network blip", async () => {
    const fake = new FakeOpenRouter()
    const client = clientWith(fake)
    const job = await client.submit(body)
    let failures = 2
    const wrapped = createOpenRouterClient({
      apiKey: OR_KEY,
      baseUrl: OR_BASE,
      sleep: async () => undefined,
      fetch: async (input, init) => {
        if (failures-- > 1) return new Response("bad gateway", { status: 502 })
        if (failures >= 0) throw new TypeError("fetch failed")
        return fake.fetch(input, init)
      },
    })
    expect((await wrapped.status(job.id)).status).toBe("queued")
  })

  it("rejects malformed job ids before any request", async () => {
    const fake = new FakeOpenRouter()
    await expect(clientWith(fake).status("../../keys")).rejects.toBeInstanceOf(
      OpenRouterError
    )
    expect(fake.seen).toHaveLength(0)
  })

  it("sends the key only to the API origin", () => {
    const client = clientWith(new FakeOpenRouter())
    expect(client.mediaHeaders(`${OR_BASE}/videos/x/content?index=0`)).toEqual({
      Authorization: `Bearer ${OR_KEY}`,
    })
    expect(
      client.mediaHeaders("https://storage.example.com/v.mp4")
    ).toBeUndefined()
    expect(
      client.mediaHeaders("https://or.test.evil.com/api/v1/videos/x")
    ).toBeUndefined()
    expect(client.mediaHeaders("not a url")).toBeUndefined()
  })
})

/* ── Status mapping ──────────────────────────────────────────────────────── */

describe("OpenRouter status mapping", () => {
  it("pending → queued, in_progress, completed, failed/expired → failed, cancelled → canceled", () => {
    expect(mapJobStatus("pending")).toBe("queued")
    expect(mapJobStatus("in_progress")).toBe("in_progress")
    expect(mapJobStatus("completed")).toBe("completed")
    expect(mapJobStatus("failed")).toBe("failed")
    expect(mapJobStatus("expired")).toBe("failed")
    expect(mapJobStatus("cancelled")).toBe("canceled")
    expect(mapJobStatus("something_new")).toBe("unknown")
    expect(mapJobStatus(undefined)).toBe("unknown")
  })

  it("completed: artifacts from unsigned_urls (key required), cost from usage", () => {
    const status = mapJob(
      {
        id: "gen-vid-1-abcdefghijklmnopqrst",
        status: "completed",
        unsigned_urls: [`${OR_BASE}/videos/x/content?index=0`],
        urls: ["https://signed.example.com/v.mp4?sig=1"],
        usage: { cost: 0.4112, is_byok: false },
      },
      "gen-vid-1-abcdefghijklmnopqrst",
      OR_BASE
    )
    expect(status.status).toBe("completed")
    expect(status.costUsd).toBe(0.4112)
    expect(status.artifacts).toEqual([
      {
        kind: "video",
        url: `${OR_BASE}/videos/x/content?index=0`,
        contentType: "video/mp4",
        authorized: true,
        fallbackUrl: "https://signed.example.com/v.mp4?sig=1",
      },
    ])
  })

  it("completed without URLs falls back to the content endpoint", () => {
    const status = mapJob(
      { status: "completed" },
      "gen-vid-1-abcdefghijklmnopqrst",
      OR_BASE
    )
    expect(status.artifacts[0]!.url).toBe(
      `${OR_BASE}/videos/gen-vid-1-abcdefghijklmnopqrst/content?index=0`
    )
  })

  it("failed carries the error text and no artifacts, even if URLs are present", () => {
    const status = mapJob(
      {
        status: "failed",
        error: "Content policy violation",
        unsigned_urls: ["https://x.test/a"],
      },
      "gen-vid-1-abcdefghijklmnopqrst",
      OR_BASE
    )
    expect(status).toMatchObject({
      status: "failed",
      error: "Content policy violation",
      artifacts: [],
    })
  })

  it("ignores non-HTTPS media URLs and uses the API's own content endpoint instead", () => {
    const status = mapJob(
      { status: "completed", unsigned_urls: ["http://evil.example.com/v.mp4"] },
      "gen-vid-1-abcdefghijklmnopqrst",
      OR_BASE
    )
    expect(status.artifacts.map((artifact) => artifact.url)).toEqual([
      `${OR_BASE}/videos/gen-vid-1-abcdefghijklmnopqrst/content?index=0`,
    ])
  })
})

/* ── Webhook token ───────────────────────────────────────────────────────── */

describe("OpenRouter webhook token", () => {
  const gid = "a".repeat(24)

  it("verifies its own token and nothing else", () => {
    const token = openRouterWebhookToken(gid, "secret")
    expect(verifyOpenRouterWebhookToken(gid, token, "secret")).toBe(true)
    expect(verifyOpenRouterWebhookToken(gid, token, "other")).toBe(false)
    expect(verifyOpenRouterWebhookToken("b".repeat(24), token, "secret")).toBe(
      false
    )
    expect(verifyOpenRouterWebhookToken(gid, "zz", "secret")).toBe(false)
    expect(verifyOpenRouterWebhookToken("nope", token, "secret")).toBe(false)
  })

  it("is domain-separated from the Higgsfield token", () => {
    expect(openRouterWebhookToken(gid, "secret")).not.toBe(
      webhookToken(gid, "secret")
    )
    expect(
      verifyOpenRouterWebhookToken(gid, webhookToken(gid, "secret"), "secret")
    ).toBe(false)
  })

  it("builds a callback URL with gid and token from the HF fallbacks", () => {
    const url = new URL(openRouterCallbackUrlFor(gid)!)
    expect(url.origin).toBe("https://vireo.test")
    expect(url.pathname).toBe("/api/webhooks/openrouter")
    expect(url.searchParams.get("gid")).toBe(gid)
    expect(
      verifyOpenRouterWebhookToken(
        gid,
        url.searchParams.get("t")!,
        "webhook-secret"
      )
    ).toBe(true)
  })
})

/* ── Local images are inlined, https passes through ──────────────────────── */

describe("withSendableMedia", () => {
  const png = tinyPng(4, 4)
  const bodyOf = (url: string) => ({
    model: "m",
    frame_images: [
      { type: "image_url", image_url: { url }, frame_type: "first_frame" },
    ],
    input_references: [{ type: "image_url", image_url: { url } }],
  })

  it("leaves https and data URLs alone and does not fetch", async () => {
    const fetchSpy = vi.fn()
    const body = bodyOf("https://media.example.com/a.png")
    expect(await withSendableMedia(body, fetchSpy as never)).toEqual(body)
    const data = bodyOf("data:image/png;base64,AAAA")
    expect(await withSendableMedia(data, fetchSpy as never)).toEqual(data)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("inlines a localhost image as a data URL, without mutating the input", async () => {
    const body = bodyOf("http://localhost:3000/api/media/u/1/a.png")
    const out = await withSendableMedia(
      body,
      (async () =>
        new Response(png, {
          headers: { "content-type": "image/png" },
        })) as typeof fetch
    )
    const expected = `data:image/png;base64,${Buffer.from(png).toString("base64")}`
    expect(out.frame_images).toMatchObject([{ image_url: { url: expected } }])
    expect(out.input_references).toMatchObject([
      { image_url: { url: expected } },
    ])
    expect(JSON.stringify(body)).toContain("http://localhost:3000")
  })

  it("refuses non-images, unreadable and oversized files with a readable message", async () => {
    const body = bodyOf("http://localhost:3000/x")
    const reply = (init: ResponseInit, data: BodyInit = png) =>
      (async () => new Response(data, init)) as typeof fetch
    await expect(
      withSendableMedia(
        body,
        reply({ headers: { "content-type": "video/mp4" } })
      )
    ).rejects.toBeInstanceOf(InlineMediaError)
    await expect(
      withSendableMedia(body, reply({ status: 404 }))
    ).rejects.toBeInstanceOf(InlineMediaError)
    await expect(
      withSendableMedia(
        body,
        reply(
          { headers: { "content-type": "image/png" } },
          new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1)
        )
      )
    ).rejects.toThrow(/too large/)
  })
})

/* ── Environment ─────────────────────────────────────────────────────────── */

describe("environment", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    resetEnvForTests()
  })

  function production(overrides: Record<string, string | undefined>) {
    Object.assign(process.env, {
      NODE_ENV: "production",
      AUTH_SECRET: "x".repeat(32),
      AUTH_RESEND_KEY: "re_key",
      MONGODB_URI: "mongodb://localhost/x",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "b",
      R2_SECRET_ACCESS_KEY: "c",
      R2_BUCKET: "d",
      R2_PUBLIC_BASE_URL: "https://cdn.example.com",
      CRON_SECRET: "cron",
    })
    for (const key of [
      "HF_CREDENTIALS",
      "HF_WEBHOOK_SECRET",
      "HF_WEBHOOK_BASE_URL",
      "OPENROUTER_API_KEY",
      "OPENROUTER_API_BASE_URL",
      "OPENROUTER_WEBHOOK_SECRET",
      "OPENROUTER_WEBHOOK_BASE_URL",
      "BYOK_ENCRYPTION_KEY",
    ])
      delete process.env[key]
    for (const [key, value] of Object.entries(overrides))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    resetEnvForTests()
  }

  it("generation is enabled when at least one provider is configured", () => {
    Object.assign(process.env, { HF_CREDENTIALS: "key:secret" })
    delete process.env.OPENROUTER_API_KEY
    resetEnvForTests()
    expect(providersConfigured()).toEqual({
      higgsfield: true,
      openrouter: false,
    })
    delete process.env.HF_CREDENTIALS
    process.env.OPENROUTER_API_KEY = "sk-or-v1-x"
    resetEnvForTests()
    expect(providersConfigured()).toEqual({
      higgsfield: false,
      openrouter: true,
    })
  })

  it("a blank budget variable keeps the default instead of switching the cap off", () => {
    process.env.OPENROUTER_MAX_USD_PER_RUN = ""
    process.env.OPENROUTER_WARN_USD = ""
    resetEnvForTests()
    expect(env().OPENROUTER_MAX_USD_PER_RUN).toBe(2)
    expect(env().OPENROUTER_WARN_USD).toBe(0.75)
    process.env.OPENROUTER_MAX_USD_PER_RUN = "0"
    resetEnvForTests()
    expect(env().OPENROUTER_MAX_USD_PER_RUN).toBe(0) // an explicit 0 disables it
  })

  it("production boots with OpenRouter only (webhook settings fall back to HF_*)", () => {
    production({
      OPENROUTER_API_KEY: "sk-or-v1-x",
      HF_WEBHOOK_SECRET: "s",
      HF_WEBHOOK_BASE_URL: "https://app.example.com",
    })
    expect(env().OPENROUTER_API_BASE_URL).toBe("https://openrouter.ai/api/v1")
  })

  it("production refuses to boot with no provider, or OpenRouter without callbacks", () => {
    production({})
    expect(() => env()).toThrow(/at least one way to generate/)
    production({ OPENROUTER_API_KEY: "sk-or-v1-x" })
    expect(() => env()).toThrow(/OPENROUTER_WEBHOOK_SECRET/)
    // Users' own keys alone are a way to generate; the key must be 32 bytes.
    production({ BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") })
    expect(() => env()).not.toThrow(/at least one way to generate/)
    production({ BYOK_ENCRYPTION_KEY: "dG9vLXNob3J0" })
    expect(() => env()).toThrow(/BYOK_ENCRYPTION_KEY must be 32 bytes/)
  })
})
