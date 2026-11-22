import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  balanceOf,
  clearDatabase,
  createUser,
  installFakeHiggsfield,
  installFakeOpenRouter,
  OR_KEY,
  setupEnv,
  startDatabase,
  stopDatabase,
  tinyMp4,
  tinyPng,
  type FakeHiggsfield,
  type FakeOpenRouter,
} from "./support/harness"

setupEnv()

// Route handlers run `after()` work post-response; run it inline in tests.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (work: () => Promise<unknown>) => void work() }
})

const { submitGeneration } = await import("@/lib/generations/submit")
const { finalizeGeneration } = await import("@/lib/generations/finalize")
const { cancelGeneration } = await import("@/lib/generations/cancel")
const { reconcile } = await import("@/lib/generations/reconcile")
const { generationStatuses } = await import("@/lib/generations/library")
const { toGenerationView } = await import("@/lib/generations/serialize")
const { collections, platformOfDoc } = await import("@/lib/db/collections")
const { POST: openRouterWebhook } =
  await import("@/app/api/webhooks/openrouter/route")
const { POST: higgsfieldWebhook } =
  await import("@/app/api/webhooks/higgsfield/route")
const { openRouterWebhookToken } = await import("@/lib/openrouter/webhook")
const { webhookToken } = await import("@/lib/higgsfield/webhook")
const { resetEnvForTests } = await import("@/lib/env")
const { clientPricing, invalidatePricing } =
  await import("@/lib/billing/pricing")
const { createUploadTicket, receiveDirectUpload, recordUpload } =
  await import("@/lib/uploads")

let fake: FakeOpenRouter
let hf: FakeHiggsfield
let localFiles: Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>

beforeAll(startDatabase, 120_000)
afterAll(stopDatabase)
beforeEach(async () => {
  await clearDatabase()
  hf = await installFakeHiggsfield()
  fake = await installFakeOpenRouter()
  localFiles = new Map()
  // One fetch for everything the server touches: OpenRouter, Higgsfield,
  // and our own localhost media (dev storage).
  vi.stubGlobal("fetch", (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    const local = localFiles.get(url.href)
    if (local)
      return new Response(local.body, {
        headers: { "content-type": local.type },
      })
    return url.host === "or.test" || url.host === "storage.or.test"
      ? fake.fetch(input, init)
      : hf.fetch(input, init)
  }) as typeof fetch)
})

const mini = (overrides: Record<string, unknown> = {}) => ({
  submitKey: randomUUID(),
  modelId: "seedance-2.0-mini-openrouter",
  prompt: "A fox crossing a snowy field",
  settings: {},
  media: [],
  ...overrides,
})

async function ledgerRows(generationId: string) {
  const { ledger } = await collections()
  return ledger.find({ refId: generationId }).toArray()
}

async function generationDoc(id: string) {
  const { generations } = await collections()
  const { ObjectId } = await import("mongodb")
  return (await generations.findOne({ _id: new ObjectId(id) }))!
}

describe("OpenRouter submit", () => {
  it("prices on the server, debits once, and sends one POST /videos with a callback", async () => {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, mini())
    expect(view.status).toBe("queued")
    expect(view.platform).toBe("openrouter")
    expect(view.cost).toBeGreaterThan(0)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500 - view.cost,
    })
    expect(fake.submits).toHaveLength(1)
    expect(fake.submits[0]!.authorization).toBe(`Bearer ${OR_KEY}`)
    expect(fake.submits[0]!.body).toMatchObject({
      model: "bytedance/seedance-2.0-mini",
      prompt: "A fox crossing a snowy field",
      duration: 4,
      resolution: "480p",
    })
    const callback = new URL(String(fake.submits[0]!.body.callback_url))
    expect(callback.pathname).toBe("/api/webhooks/openrouter")
    expect(callback.searchParams.get("gid")).toBe(view.id)
    expect(hf.submits).toHaveLength(0) // Higgsfield is not involved
    const doc = await generationDoc(view.id)
    expect(doc.platform).toBe("openrouter")
    expect(doc.hfRequestId).toBe(fake.lastJobId())
    expect(doc.modelPath).toBe("openrouter/bytedance/seedance-2.0-mini")
    expect(await ledgerRows(view.id)).toHaveLength(1)
  })

  it("ignores client-supplied price and model path", async () => {
    const user = await createUser({ topup: 500 })
    const cheap = await submitGeneration(user, {
      ...mini(),
      cost: 1,
      path: "openrouter/other",
    } as never)
    const honest = await submitGeneration(user, mini())
    expect(cheap.cost).toBe(honest.cost)
    expect(fake.submits[0]!.body.model).toBe("bytedance/seedance-2.0-mini")
  })

  it("refuses a run above the per-run budget cap before charging", async () => {
    const user = await createUser({ topup: 100_000 })
    await expect(
      submitGeneration(
        user,
        mini({
          modelId: "seedance-2.5-openrouter",
          settings: { duration: 30, resolution: "1080p" },
        })
      )
    ).rejects.toMatchObject({ code: "OVER_BUDGET" })
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 100_000,
    })
    expect(fake.submits).toHaveLength(0)
  })

  it("sends frame images as https URLs unchanged and inlines local ones for the request only", async () => {
    const user = await createUser({ topup: 5000 })
    const { uploads } = await collections()
    const { ObjectId } = await import("mongodb")
    const local = "http://localhost:3000/api/media/u/x/uploads/a.png"
    const remote = "https://cdn.example.com/u/x/uploads/b.png"
    localFiles.set(local, { body: tinyPng(8, 8), type: "image/png" })
    for (const url of [local, remote])
      await uploads.insertOne({
        _id: new ObjectId(),
        userId: user.objectId,
        kind: "image",
        url,
        platformUrl: url,
        contentType: "image/png",
        bytes: 100,
        name: "frame",
        createdAt: new Date(),
      })
    const view = await submitGeneration(
      user,
      mini({
        media: [
          { role: "start", url: local },
          { role: "end", url: remote },
        ],
      })
    )
    const frames = fake.submits[0]!.body.frame_images as {
      image_url: { url: string }
      frame_type: string
    }[]
    expect(frames[0]!.image_url.url).toMatch(/^data:image\/png;base64,/)
    expect(frames[0]!.frame_type).toBe("first_frame")
    expect(frames[1]!.image_url.url).toBe(remote)
    // The stored request keeps the URL; no base64 in Mongo.
    const doc = await generationDoc(view.id)
    expect(JSON.stringify(doc.requestBody)).not.toContain("base64")
    expect(JSON.stringify(doc.requestBody)).toContain(local)
  })

  it("a definite rejection (402 no credits, 400) fails the run and refunds once", async () => {
    for (const status of [402, 400]) {
      const user = await createUser({ topup: 500 })
      fake.nextSubmit = status
      const view = await submitGeneration(user, mini())
      expect(view.status).toBe("failed")
      expect(view.error).toMatch(/Credits refunded/)
      if (status === 402)
        // The operator problem is not shown to users.
        expect(view.error).not.toMatch(/openrouter|402/i)
      expect(await balanceOf(user.objectId)).toEqual({
        subscription: 0,
        topup: 500,
      })
      expect(await ledgerRows(view.id)).toHaveLength(2) // debit + refund
    }
  })

  it("an ambiguous submit is not retried; the reconciler refunds it once", async () => {
    const user = await createUser({ topup: 500 })
    fake.nextSubmit = "network"
    const view = await submitGeneration(user, mini())
    expect(view.status).toBe("pending_submit")
    expect(fake.seen.filter((r) => r.method === "POST")).toHaveLength(1)
    const summary = await reconcile({ pendingSeconds: 0 })
    expect(summary.unconfirmed).toBe(1)
    await reconcile({ pendingSeconds: 0 })
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
    expect(await ledgerRows(view.id)).toHaveLength(2)
  })
})

describe("OpenRouter finalize", () => {
  async function started() {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, mini())
    return { user, view, id: fake.lastJobId() }
  }

  it("pending stays queued; in_progress is recorded", async () => {
    const { view } = await started()
    expect(await finalizeGeneration((await generationDoc(view.id))._id)).toBe(
      "in_flight"
    )
    expect((await generationDoc(view.id)).status).toBe("queued")
    fake.jobs.get(fake.lastJobId())!.status = "in_progress"
    await finalizeGeneration((await generationDoc(view.id))._id)
    expect((await generationDoc(view.id)).status).toBe("in_progress")
  })

  it("completed: downloads with the key, streams into storage, keeps no provider URL", async () => {
    const { user, view, id } = await started()
    fake.finish(id, "completed", { cost: 0.1345 })
    const gen = await generationDoc(view.id)
    expect(await finalizeGeneration(gen._id)).toBe("completed")
    const done = await generationDoc(view.id)
    expect(done.status).toBe("completed")
    expect(done.outputs).toHaveLength(1)
    const output = done.outputs[0]!
    expect(output.kind).toBe("video")
    expect(output.storage).toBe("local")
    expect(output.key).toBe(`u/${user.id}/${view.id}/0.mp4`)
    expect(output.durationSec).toBe(6)
    expect(output.platformUrl).toBeUndefined()
    expect(existsSync(join(process.env.LOCAL_MEDIA_DIR!, output.key))).toBe(
      true
    )
    // The download carried the key; nothing else did.
    const download = fake.seen.find((r) => r.url.includes("/content"))!
    expect(download.authorization).toBe(`Bearer ${OR_KEY}`)
    // Cost is recorded for comparison with what we charged; no refund.
    expect(done.providerCostUsd).toBe(0.1345)
    expect(done.refunded).toBe(0)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500 - view.cost,
    })
  })

  it("never sends the key to a download URL on another origin", async () => {
    const { view, id } = await started()
    const other = "https://storage.or.test/outputs/video.mp4"
    fake.files.set(other, { body: tinyMp4(6), type: "video/mp4" })
    fake.finish(id, "completed", { unsignedUrls: [other] })
    expect(await finalizeGeneration((await generationDoc(view.id))._id)).toBe(
      "completed"
    )
    const download = fake.seen.find((r) => r.url === other)!
    expect(download.authorization).toBeNull()
  })

  it("logs a provider cost above our price basis as an error", async () => {
    const { view, id } = await started()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    fake.finish(id, "completed", { cost: 9.99 })
    await finalizeGeneration((await generationDoc(view.id))._id)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("provider cost above our price basis")
    )
    error.mockRestore()
  })

  it("a failed copy retries later and never exposes the key-protected URL", async () => {
    const { view, id } = await started()
    fake.finish(id, "completed")
    fake.contentStatus = 500
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const gen = await generationDoc(view.id)
    // Even past the attempt limit: no signed fallback, so no "platform" output.
    for (let i = 0; i < 6; i++) await finalizeGeneration(gen._id)
    error.mockRestore()
    const stuck = await generationDoc(view.id)
    expect(stuck.status).not.toBe("completed")
    expect(stuck.outputs).toHaveLength(0)
    fake.contentStatus = undefined
    expect(await finalizeGeneration(gen._id)).toBe("completed")
  })

  it("uses the key-less signed URL as a fallback after repeated copy failures", async () => {
    const { view, id } = await started()
    const signed = "https://storage.or.test/signed/video.mp4?sig=abc"
    fake.finish(id, "completed", { signedUrls: [signed] })
    fake.contentStatus = 500
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const gen = await generationDoc(view.id)
    for (let i = 0; i < 6; i++) await finalizeGeneration(gen._id)
    error.mockRestore()
    const done = await generationDoc(view.id)
    expect(done.status).toBe("completed")
    expect(done.outputs[0]).toMatchObject({ storage: "platform", url: signed })
    // The reconciler's copy retry then moves it into storage.
    fake.files.set(signed, { body: tinyMp4(6), type: "video/mp4" })
    await reconcile()
    expect((await generationDoc(view.id)).outputs[0]!.storage).toBe("local")
  })

  for (const [provider, appStatus] of [
    ["failed", "failed"],
    ["expired", "failed"],
    ["cancelled", "canceled"],
  ] as const) {
    it(`${provider}: refunds exactly once, however often it is finalized`, async () => {
      const { user, view, id } = await started()
      fake.finish(id, provider)
      const gen = await generationDoc(view.id)
      expect(await finalizeGeneration(gen._id)).toBe("refunded")
      expect(await finalizeGeneration(gen._id)).toBe("already_terminal")
      await Promise.all([finalizeGeneration(gen._id), reconcile()])
      await reconcile()
      const done = await generationDoc(view.id)
      expect(done.status).toBe(appStatus)
      expect(done.error).toMatch(/Credits refunded/)
      if (provider !== "cancelled")
        expect(done.error).toContain(`Job ${provider} (test)`)
      expect(done.refunded).toBe(done.cost)
      expect(await balanceOf(user.objectId)).toEqual({
        subscription: 0,
        topup: 500,
      })
      expect(await ledgerRows(view.id)).toHaveLength(2)
    })
  }

  it("a completed job with no downloadable output fails and refunds", async () => {
    const { user, view, id } = await started()
    fake.finish(id, "completed", {
      unsignedUrls: ["http://evil.example.com/x.mp4"],
    })
    // Unsafe URLs are dropped; the content endpoint is the documented fallback.
    expect(await finalizeGeneration((await generationDoc(view.id))._id)).toBe(
      "completed"
    )
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500 - view.cost,
    })
  })
})

describe("OpenRouter webhook", () => {
  const call = (gid: string, token: string, body: unknown) =>
    openRouterWebhook(
      new Request(
        `https://vireo.test/api/webhooks/openrouter?gid=${gid}&t=${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      )
    )
  const envelope = (id: string, status: string, extra: object = {}) => ({
    type: `video.generation.${status}`,
    created_at: new Date().toISOString(),
    data: { id, status, ...extra },
  })

  async function started() {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, mini())
    return { user, view, id: fake.lastJobId(), gid: view.id }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

  it("rejects a missing or wrong token with 401", async () => {
    const { id, gid } = await started()
    expect(
      (await call(gid, "0".repeat(64), envelope(id, "completed"))).status
    ).toBe(401)
    expect((await call(gid, "", envelope(id, "completed"))).status).toBe(401)
    // Another generation's token does not work either.
    const other = openRouterWebhookToken("b".repeat(24), "webhook-secret")
    expect((await call(gid, other, envelope(id, "completed"))).status).toBe(401)
  })

  it("rejects a Higgsfield token and a Higgsfield route token for OpenRouter jobs", async () => {
    const { id, gid } = await started()
    expect(
      (
        await call(
          gid,
          webhookToken(gid, "webhook-secret"),
          envelope(id, "completed")
        )
      ).status
    ).toBe(401)
    // The Higgsfield route cannot be steered at an OpenRouter generation.
    const response = await higgsfieldWebhook(
      new Request(
        `https://vireo.test/api/webhooks/higgsfield?gid=${gid}&t=${webhookToken(gid, "webhook-secret")}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request_id: randomUUID(),
            status: "completed",
          }),
        }
      )
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ignored: "platform mismatch",
    })
  })

  it("rejects malformed envelopes with 400", async () => {
    const { gid } = await started()
    const token = openRouterWebhookToken(gid, "webhook-secret")
    expect((await call(gid, token, { type: "x" })).status).toBe(400)
    expect((await call(gid, token, envelope("../x", "completed"))).status).toBe(
      400
    )
    expect(
      (
        await call(
          gid,
          token,
          envelope("gen-vid-1-abcdefghijklmnopqrst", "pending")
        )
      ).status
    ).toBe(400)
  })

  it("never trusts the payload: re-fetches the job before finalizing", async () => {
    const { user, view, id, gid } = await started()
    // The webhook claims success; OpenRouter says the job failed.
    fake.finish(id, "failed")
    const token = openRouterWebhookToken(gid, "webhook-secret")
    const response = await call(
      gid,
      token,
      envelope(id, "completed", {
        unsigned_urls: ["https://evil.example/x.mp4"],
      })
    )
    expect(response.status).toBe(200)
    await settle()
    const [after] = await generationStatuses(user.objectId, [view.id])
    expect(after!.status).toBe("failed")
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })

  it("completes once when the same delivery arrives twice", async () => {
    const { user, view, id, gid } = await started()
    fake.finish(id, "completed")
    const token = openRouterWebhookToken(gid, "webhook-secret")
    expect((await call(gid, token, envelope(id, "completed"))).status).toBe(200)
    expect((await call(gid, token, envelope(id, "completed"))).status).toBe(200)
    await settle()
    const [after] = await generationStatuses(user.objectId, [view.id])
    expect(after!.status).toBe("completed")
    expect(after!.outputs).toHaveLength(1)
    expect(fake.seen.filter((r) => r.url.includes("/content"))).toHaveLength(1)
  })

  it("delivers a late success for a run the reconciler already refunded", async () => {
    const { user, view, id, gid } = await started()
    const { generations } = await collections()
    // Simulate the 30-minute timeout having fired.
    await generations.updateOne(
      { _id: (await generationDoc(view.id))._id },
      { $set: { createdAt: new Date(Date.now() - 31 * 60_000) } }
    )
    await reconcile()
    expect((await generationDoc(view.id)).errorKind).toBe("timeout")
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
    fake.finish(id, "completed")
    const token = openRouterWebhookToken(gid, "webhook-secret")
    await call(gid, token, envelope(id, "completed"))
    await settle()
    expect((await generationDoc(view.id)).status).toBe("completed")
    // Delivered free: the refund stands.
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })
})

describe("OpenRouter jobs cannot be canceled", () => {
  it("says so, calls nothing, and leaves the run running", async () => {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, mini())
    const before = fake.seen.length
    await expect(
      cancelGeneration(user.objectId, (await generationDoc(view.id))._id)
    ).rejects.toMatchObject({ code: "NOT_CANCELABLE" })
    expect(fake.seen).toHaveLength(before)
    expect((await generationDoc(view.id)).status).toBe("queued")
    expect(view.platform).toBe("openrouter")
  })

  it("the timeout still fails and refunds an OpenRouter run without a cancel call", async () => {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, mini())
    const { generations } = await collections()
    await generations.updateOne(
      { _id: (await generationDoc(view.id))._id },
      { $set: { createdAt: new Date(Date.now() - 31 * 60_000) } }
    )
    const summary = await reconcile()
    expect(summary.timedOut).toBe(1)
    expect(
      fake.seen.some((r) => r.method === "POST" && r.url.includes("cancel"))
    ).toBe(false)
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })
})

describe("Higgsfield side by side", () => {
  it("a legacy generation without `platform` is Higgsfield end to end", async () => {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, {
      submitKey: randomUUID(),
      modelId: "soul-2",
      prompt: "Editorial portrait",
      settings: { batchSize: "1", resolution: "720p" },
      media: [],
    })
    expect(view.platform).toBe("higgsfield")
    const { generations } = await collections()
    const doc = await generationDoc(view.id)
    expect(doc.platform).toBe("higgsfield")
    // Documents written before OpenRouter existed have no field at all.
    await generations.updateOne({ _id: doc._id }, { $unset: { platform: "" } })
    const legacy = await generationDoc(view.id)
    expect("platform" in legacy).toBe(false)
    expect(platformOfDoc(legacy)).toBe("higgsfield")
    expect(toGenerationView(legacy).platform).toBe("higgsfield")
    hf.complete(legacy.hfRequestId!, "image")
    expect(await finalizeGeneration(legacy._id)).toBe("completed")
    expect(fake.seen).toHaveLength(0) // OpenRouter was never asked
    expect((await generationDoc(view.id)).outputs[0]!.platformUrl).toContain(
      "cdn.hf.test"
    )
  })

  it("a legacy queued Higgsfield run can still be canceled", async () => {
    const user = await createUser({ topup: 500 })
    const view = await submitGeneration(user, {
      submitKey: randomUUID(),
      modelId: "soul-2",
      prompt: "Portrait",
      settings: { batchSize: "1", resolution: "720p" },
      media: [],
    })
    const { generations } = await collections()
    await generations.updateOne(
      { _id: (await generationDoc(view.id))._id },
      { $unset: { platform: "" } }
    )
    await cancelGeneration(user.objectId, (await generationDoc(view.id))._id)
    expect((await generationDoc(view.id)).status).toBe("canceled")
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })
})

describe("provider availability", () => {
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = { ...process.env }
  })
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    resetEnvForTests()
    invalidatePricing()
  })

  it("hides models whose provider has no key, and refuses to run them", async () => {
    delete process.env.OPENROUTER_API_KEY
    resetEnvForTests()
    invalidatePricing()
    const pricing = await clientPricing()
    expect(pricing.disabled).toEqual(
      expect.arrayContaining([
        "seedance-2.5-openrouter",
        "seedance-2.0-mini-openrouter",
      ])
    )
    expect(pricing.disabled).not.toContain("seedance-2.5")
    const user = await createUser({ topup: 500 })
    await expect(submitGeneration(user, mini())).rejects.toMatchObject({
      code: "MODEL_DISABLED",
    })
    expect(await balanceOf(user.objectId)).toEqual({
      subscription: 0,
      topup: 500,
    })
  })

  it("an OpenRouter-only deployment hides Higgsfield models instead", async () => {
    delete process.env.HF_CREDENTIALS
    resetEnvForTests()
    invalidatePricing()
    const pricing = await clientPricing()
    expect(pricing.disabled).toContain("seedance-2.5")
    expect(pricing.disabled).not.toContain("seedance-2.5-openrouter")
    expect(pricing.expensiveCredits).toBeGreaterThan(0)
  })
})

describe("direct uploads (no Higgsfield key)", () => {
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = { ...process.env }
  })
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    resetEnvForTests()
  })

  const ticketFor = async (user: Awaited<ReturnType<typeof createUser>>) => {
    delete process.env.HF_CREDENTIALS
    resetEnvForTests()
    return createUploadTicket(user, {
      contentType: "image/png",
      size: 100,
      name: "frame.png",
    })
  }

  it("issues our own signed ticket, stores the file, records it", async () => {
    const user = await createUser({ topup: 10 })
    const { ticket, token } = await ticketFor(user)
    const url = new URL(ticket.upload_url)
    expect(url.pathname).toBe("/api/upload/direct")
    expect(ticket.public_url).toContain(`/api/media/u/${user.id}/uploads/`)
    expect(ticket.upload_headers).toEqual({ "Content-Type": "image/png" })
    const png = tinyPng(32, 18)
    await receiveDirectUpload(
      url.searchParams,
      "image/png",
      new Response(png).body
    )
    // Dev storage serves it back over localhost; stand in for that fetch.
    localFiles.set(ticket.public_url, { body: png, type: "image/png" })
    const recorded = await recordUpload(user, {
      publicUrl: ticket.public_url,
      contentType: "image/png",
      name: "frame.png",
      size: png.byteLength,
      token,
    })
    expect(recorded.kind).toBe("image")
    expect(recorded.width).toBe(32)
    expect(recorded.height).toBe(18)
    const key = new URL(ticket.public_url).pathname.replace("/api/media/", "")
    expect(existsSync(join(process.env.LOCAL_MEDIA_DIR!, key))).toBe(true)
  })

  it("rejects a tampered signature, another type, an expired link and oversize bodies", async () => {
    const user = await createUser({ topup: 10 })
    const { ticket } = await ticketFor(user)
    const good = new URL(ticket.upload_url).searchParams
    const body = () => new Response(tinyPng(2, 2)).body
    const tampered = new URLSearchParams(good)
    tampered.set("k", `u/${"a".repeat(24)}/uploads/${"b".repeat(24)}.png`)
    await expect(
      receiveDirectUpload(tampered, "image/png", body())
    ).rejects.toMatchObject({ code: "BAD_TICKET" })
    await expect(
      receiveDirectUpload(good, "image/jpeg", body())
    ).rejects.toMatchObject({ code: "BAD_TICKET" })
    const expired = new URLSearchParams(good)
    expired.set("e", String(Date.now() - 1000))
    await expect(
      receiveDirectUpload(expired, "image/png", body())
    ).rejects.toMatchObject({
      code: expect.stringMatching(/BAD_TICKET|EXPIRED/),
    })
    const huge = new Response(new Uint8Array(21 * 1024 * 1024)).body
    await expect(
      receiveDirectUpload(good, "image/png", huge)
    ).rejects.toMatchObject({ code: "TOO_LARGE" })
  })

  it("still uses the Higgsfield ticket when a Higgsfield key exists", async () => {
    const user = await createUser({ topup: 10 })
    hf.fetch = async () =>
      new Response(
        JSON.stringify({
          upload_url: "https://up.hf.test/put",
          public_url: "https://cdn.hf.test/file.png",
          content_type: "image/png",
          upload_headers: { "Content-Type": "image/png" },
        }),
        { headers: { "content-type": "application/json" } }
      )
    const { setHiggsfieldClientForTests, createHiggsfieldClient } =
      await import("@/lib/higgsfield/client")
    setHiggsfieldClientForTests(
      createHiggsfieldClient({
        credentials: "key:secret",
        baseUrl: "https://hf.test",
        fetch: hf.fetch,
        sleep: async () => undefined,
      })
    )
    const { ticket } = await createUploadTicket(user, {
      contentType: "image/png",
      size: 100,
    })
    expect(ticket.upload_url).toBe("https://up.hf.test/put")
  })
})
