import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MongoMemoryReplSet } from "mongodb-memory-server"
import { ObjectId } from "mongodb"

/**
 * Test harness: a single-node MongoDB replica set (transactions need one), a
 * fake Higgsfield REST API, and stubbed CDN downloads. Call `setupEnv()` before
 * importing app modules so env() sees the test configuration.
 */
export function setupEnv(): void {
  Object.assign(process.env, {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    AUTH_SECRET: "test-secret-test-secret-test-secret",
    HF_API_BASE_URL: "https://hf.test",
    HF_CREDENTIALS: "key:secret",
    HF_WEBHOOK_SECRET: "webhook-secret",
    HF_WEBHOOK_BASE_URL: "https://vireo.test",
    HF_PRICE_GUARD: "false",
    OPENROUTER_API_KEY: "sk-or-v1-test-key-0123456789",
    OPENROUTER_API_BASE_URL: "https://or.test/api/v1",
    OPENROUTER_MAX_USD_PER_RUN: "2",
    CREDIT_USD_VALUE: "0.01",
    CREDIT_MARKUP: "2",
    RUN_TIMEOUT_MINUTES: "30",
    LOCAL_MEDIA_DIR: mkdtempSync(join(tmpdir(), "vireo-media-")),
  })
}

let replSet: MongoMemoryReplSet | undefined

export async function startDatabase(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  })
  process.env.MONGODB_URI = replSet.getUri()
  process.env.MONGODB_DB = `vireo-test-${Date.now()}`
  const { resetEnvForTests } = await import("@/lib/env")
  resetEnvForTests()
  const { db } = await import("@/lib/db/mongo")
  const { ensureIndexes } = await import("@/lib/db/indexes")
  await ensureIndexes(await db())
}

export async function stopDatabase(): Promise<void> {
  const { closeMongoForTests } = await import("@/lib/db/mongo")
  await closeMongoForTests()
  await replSet?.stop()
}

export async function clearDatabase(): Promise<void> {
  const { db } = await import("@/lib/db/mongo")
  const database = await db()
  for (const name of [
    "users",
    "generations",
    "credit_ledger",
    "uploads",
    "projects",
    "rate_limits",
    "hf_webhook_events",
    "stripe_events",
    "model_pricing",
    "reports",
    "user_keys",
  ])
    await database.collection(name).deleteMany({})
  const { invalidatePricing } = await import("@/lib/billing/pricing")
  invalidatePricing()
}

export async function createUser(
  credits: { subscription?: number; topup?: number } = {},
  plan: "free" | "starter" | "plus" | "ultra" = "plus"
) {
  const { collections } = await import("@/lib/db/collections")
  const { users } = await collections()
  const _id = new ObjectId()
  const email = `user-${_id.toHexString()}@example.com`
  await users.insertOne({
    _id,
    email,
    role: "user",
    plan,
    credits: {
      subscription: credits.subscription ?? 0,
      topup: credits.topup ?? 0,
    },
    createdAt: new Date(),
  })
  return {
    id: _id.toHexString(),
    objectId: _id,
    role: "user" as const,
    email,
  }
}

export async function balanceOf(userId: ObjectId) {
  const { collections } = await import("@/lib/db/collections")
  const { users } = await collections()
  return (await users.findOne({ _id: userId }))!.credits
}

/* ── Fake Higgsfield API ─────────────────────────────────────────────────── */

export type FakeRequest = {
  status: string
  artifacts?: Record<string, unknown>
  error?: string
  path: string
  body: Record<string, unknown>
  webhook?: string
}

export class FakeHiggsfield {
  requests = new Map<string, FakeRequest>()
  submits: { path: string; body: Record<string, unknown>; webhook?: string }[] =
    []
  /** Next submit response: "ok" | an HTTP status | "network" (ambiguous). */
  nextSubmit: "ok" | number | "network" = "ok"
  cdn = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>()
  /** Authorization header of every API call (not CDN downloads), in order. */
  seenAuth: { url: string; authorization: string | null }[] = []
  private counter = 0

  complete(requestId: string, kind: "image" | "video" = "image", count = 1) {
    const request = this.requests.get(requestId)!
    const urls = Array.from({ length: count }, (_, i) => {
      const url = `https://cdn.hf.test/${requestId}/${i}.${kind === "image" ? "png" : "mp4"}`
      this.cdn.set(url, {
        body: kind === "image" ? tinyPng(16, 9) : tinyMp4(6),
        type: kind === "image" ? "image/png" : "video/mp4",
      })
      return url
    })
    request.status = "completed"
    request.artifacts =
      kind === "image"
        ? { images: urls.map((url) => ({ url })) }
        : { video: { url: urls[0] } }
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    const method = init?.method ?? "GET"
    if (url.host !== "cdn.hf.test")
      this.seenAuth.push({
        url: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
      })
    if (url.host === "cdn.hf.test") {
      const file = this.cdn.get(url.href)
      if (!file) return new Response("missing", { status: 404 })
      return new Response(file.body, {
        headers: {
          "content-type": file.type,
          "content-length": String(file.body.byteLength),
        },
      })
    }
    const json = (data: unknown, status = 200) =>
      new Response(data === null ? null : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      })
    const statusMatch = url.pathname.match(/^\/requests\/([^/]+)\/status$/)
    if (statusMatch && method === "GET") {
      const request = this.requests.get(statusMatch[1]!)
      if (!request) return json({ detail: "Not found" }, 404)
      return json({
        status: request.status,
        request_id: statusMatch[1],
        ...(request.artifacts ?? {}),
        ...(request.error ? { error: request.error } : {}),
      })
    }
    const cancelMatch = url.pathname.match(/^\/requests\/([^/]+)\/cancel$/)
    if (cancelMatch && method === "POST") {
      const request = this.requests.get(cancelMatch[1]!)
      if (!request) return json({ detail: "Not found" }, 404)
      if (request.status !== "queued")
        return json({ detail: "Already started" }, 400)
      request.status = "canceled"
      return json(null, 202)
    }
    if (method === "POST") {
      const outcome = this.nextSubmit
      this.nextSubmit = "ok"
      if (outcome === "network") throw new TypeError("fetch failed")
      if (typeof outcome === "number")
        return json({ detail: "Rejected by test" }, outcome)
      const path = url.pathname.slice(1)
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >
      const webhook = url.searchParams.get("hf_webhook") ?? undefined
      const requestId = `00000000-0000-4000-8000-${String(++this.counter).padStart(12, "0")}`
      this.requests.set(requestId, { status: "queued", path, body, webhook })
      this.submits.push({ path, body, webhook })
      return json({
        status: "queued",
        request_id: requestId,
        status_url: `https://hf.test/requests/${requestId}/status`,
        cancel_url: `https://hf.test/requests/${requestId}/cancel`,
      })
    }
    return json({ detail: "Unhandled" }, 404)
  }
}

export async function installFakeHiggsfield(): Promise<FakeHiggsfield> {
  const fake = new FakeHiggsfield()
  const { createHiggsfieldClient, setHiggsfieldClientForTests } =
    await import("@/lib/higgsfield/client")
  setHiggsfieldClientForTests(
    createHiggsfieldClient({
      credentials: "key:secret",
      baseUrl: "https://hf.test",
      fetch: fake.fetch,
      sleep: async () => undefined,
    })
  )
  return fake
}

/* ── Tiny media fixtures ─────────────────────────────────────────────────── */

export function tinyPng(
  width: number,
  height: number
): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write("IHDR", 12, "ascii")
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return new Uint8Array(buffer)
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, "ascii")
  return Buffer.concat([header, payload])
}

/** Minimal MP4: ftyp + moov(mvhd v0, trak(tkhd v0 1280×720)). */
export function tinyMp4(
  seconds: number,
  width = 1280,
  height = 720
): Uint8Array<ArrayBuffer> {
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt32BE(1000, 12) // timescale
  mvhd.writeUInt32BE(seconds * 1000, 16) // duration
  const tkhd = Buffer.alloc(84)
  tkhd.writeUInt32BE(width * 65536, 76)
  tkhd.writeUInt32BE(height * 65536, 80)
  const trak = box("trak", box("tkhd", tkhd))
  const moov = box("moov", Buffer.concat([box("mvhd", mvhd), trak]))
  const ftyp = box("ftyp", Buffer.from("isom0000isomiso2", "ascii"))
  return new Uint8Array(Buffer.concat([ftyp, moov]))
}

export function tinyWav(seconds: number): Uint8Array<ArrayBuffer> {
  const byteRate = 8000
  const data = Buffer.alloc(8)
  const buffer = Buffer.alloc(44)
  buffer.write("RIFF", 0, "ascii")
  buffer.writeUInt32BE(0, 4)
  buffer.write("WAVE", 8, "ascii")
  buffer.write("fmt ", 12, "ascii")
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.write("data", 36, "ascii")
  buffer.writeUInt32LE(byteRate * seconds, 40)
  return new Uint8Array(Buffer.concat([buffer, data]))
}

/* ── Fake OpenRouter video API ───────────────────────────────────────────── */

export const OR_BASE = "https://or.test/api/v1"
export const OR_KEY = "sk-or-v1-test-key-0123456789"

export type FakeJob = {
  status: string
  body: Record<string, unknown>
  callback?: string
  error?: string
  cost?: number
  /** Listed in `unsigned_urls` (defaults to the content endpoint). */
  unsignedUrls?: string[]
  /** Signed, key-less copies (`urls`). */
  signedUrls?: string[]
}

export type SeenRequest = {
  method: string
  url: string
  authorization: string | null
}

export class FakeOpenRouter {
  jobs = new Map<string, FakeJob>()
  submits: { body: Record<string, unknown>; authorization: string | null }[] =
    []
  seen: SeenRequest[] = []
  /** Next submit response: "ok" | an HTTP status | "network" (ambiguous). */
  nextSubmit: "ok" | number | "network" = "ok"
  /** Extra files served by URL (signed storage URLs and so on). */
  files = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>()
  /** Content downloads that should fail with this status (copy-failure tests). */
  contentStatus?: number
  /** Bearer keys the API accepts: the server key, plus any user key a test adds. */
  acceptedKeys = new Set<string>([OR_KEY])
  private counter = 0

  /** Make a submitted job reach a terminal state. */
  finish(
    id: string,
    state: "completed" | "failed" | "expired" | "cancelled",
    extra: Partial<FakeJob> = {}
  ) {
    const job = this.jobs.get(id)!
    job.status = state
    if (state !== "completed") job.error ??= `Job ${state} (test)`
    Object.assign(job, extra)
  }

  lastJobId(): string {
    return [...this.jobs.keys()].at(-1)!
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    this.seen.push({
      method,
      url: url.href,
      authorization: headers.get("authorization"),
    })
    const json = (data: unknown, status = 200) =>
      new Response(data === null ? null : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      })
    const file = this.files.get(url.href)
    if (file)
      return new Response(file.body, {
        headers: {
          "content-type": file.type,
          "content-length": String(file.body.byteLength),
        },
      })
    if (url.host !== "or.test") return new Response("missing", { status: 404 })
    const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "")
    if (!this.acceptedKeys.has(bearer))
      return json(
        { error: { code: 401, message: "Missing Authentication header" } },
        401
      )

    if (url.pathname === "/api/v1/key" && method === "GET")
      return json({ data: { label: "test", limit: null, usage: 0 } })
    const content = url.pathname.match(/^\/api\/v1\/videos\/([^/]+)\/content$/)
    if (content && method === "GET") {
      const job = this.jobs.get(content[1]!)
      if (!job || job.status !== "completed")
        return json(
          { error: { code: 404, message: "Resource not found" } },
          404
        )
      if (this.contentStatus)
        return json(
          { error: { code: this.contentStatus, message: "boom" } },
          this.contentStatus
        )
      const video = tinyMp4(6)
      return new Response(video, {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(video.byteLength),
        },
      })
    }
    const poll = url.pathname.match(/^\/api\/v1\/videos\/([^/]+)$/)
    if (poll && method === "GET") {
      const id = poll[1]!
      const job = this.jobs.get(id)
      if (!job)
        return json(
          { error: { code: 404, message: "Resource not found" } },
          404
        )
      return json({
        id,
        generation_id: id,
        polling_url: `${OR_BASE}/videos/${id}`,
        status: job.status,
        ...(job.status === "completed"
          ? {
              unsigned_urls: job.unsignedUrls ?? [
                `${OR_BASE}/videos/${id}/content?index=0`,
              ],
              ...(job.signedUrls ? { urls: job.signedUrls } : {}),
              usage: { cost: job.cost ?? 0.4112, is_byok: false },
            }
          : {}),
        ...(job.error && job.status !== "completed"
          ? { error: job.error }
          : {}),
      })
    }
    if (url.pathname === "/api/v1/videos" && method === "POST") {
      const outcome = this.nextSubmit
      this.nextSubmit = "ok"
      if (outcome === "network") throw new TypeError("fetch failed")
      if (typeof outcome === "number")
        return json(
          {
            error: { code: outcome, message: `Rejected by test (${outcome})` },
          },
          outcome
        )
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >
      this.submits.push({
        body,
        authorization: headers.get("authorization"),
      })
      const id = `gen-vid-1790000000-${String(++this.counter).padStart(20, "A")}`
      this.jobs.set(id, {
        status: "pending",
        body,
        callback:
          typeof body.callback_url === "string" ? body.callback_url : undefined,
      })
      return json(
        {
          id,
          generation_id: id,
          polling_url: `${OR_BASE}/videos/${id}`,
          status: "pending",
        },
        202
      )
    }
    return json({ error: { code: 404, message: "Unhandled" } }, 404)
  }
}

export async function installFakeOpenRouter(): Promise<FakeOpenRouter> {
  const fake = new FakeOpenRouter()
  const { createOpenRouterClient, setOpenRouterClientForTests } =
    await import("@/lib/openrouter/client")
  setOpenRouterClientForTests(
    createOpenRouterClient({
      apiKey: OR_KEY,
      baseUrl: OR_BASE,
      fetch: fake.fetch,
      sleep: async () => undefined,
    })
  )
  return fake
}
