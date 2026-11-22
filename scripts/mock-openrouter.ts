/**
 * A local stand-in for OpenRouter's video API, for development and E2E tests
 * without a key or any spend. Implements the documented shapes
 * (https://openrouter.ai/docs/guides/overview/multimodal/video-generation):
 *   POST /api/v1/videos              → 202 {id, generation_id, polling_url, status}
 *   GET  /api/v1/videos/{id}         → pending → in_progress → completed | failed
 *   GET  /api/v1/videos/{id}/content → the MP4 (needs the Authorization header)
 *   callback_url                     → POST {type: "video.generation.<status>", data}
 *
 *   pnpm mock:openrouter             # http://localhost:4020/api/v1
 *   OPENROUTER_API_BASE_URL=http://localhost:4020/api/v1  OPENROUTER_API_KEY=mock-key
 *
 * Prompt tokens steer outcomes, like the Higgsfield mock: "[fail]" → failed
 * (error in the poll response, HTTP 200), "[slow]" → stays pending 20 s,
 * "[402]" → submit answers 402 (no credits). Anything else completes in ~6 s.
 * Like the real API it rejects image URLs that are neither https nor data URLs.
 * Output is our own sample media from /public/media/loops.
 */
import { randomBytes } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { join } from "node:path"

const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 4020)
const ORIGIN = `http://localhost:${PORT}`
const API = `${ORIGIN}/api/v1`
const LOOPS = join(process.cwd(), "public", "media", "loops")
const videos = readdirSync(LOOPS).filter((file) => file.endsWith(".mp4"))

type Job = {
  body: Record<string, unknown>
  callback?: string
  createdAt: number
  outcome: "completed" | "failed"
  slow: boolean
  notified: boolean
}

const jobs = new Map<string, Job>()

function send(res: ServerResponse, status: number, data?: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(data === undefined ? "" : JSON.stringify(data))
}

const fail = (res: ServerResponse, code: number, message: string) =>
  send(res, code, { error: { code, message } })

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function newId(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const suffix = [...randomBytes(20)]
    .map((byte) => alphabet[byte % alphabet.length])
    .join("")
  return `gen-vid-${Math.floor(Date.now() / 1000)}-${suffix}`
}

function imageProblem(body: Record<string, unknown>): string | undefined {
  const lists = [body.frame_images, body.input_references]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const url = (item as { image_url?: { url?: unknown } }).image_url?.url
      if (
        typeof url !== "string" ||
        !(url.startsWith("https://") || url.startsWith("data:image/"))
      )
        return "Image URLs must be https or base64 data URLs"
    }
  }
  return undefined
}

function snapshot(id: string, job: Job): Record<string, unknown> {
  const age = Date.now() - job.createdAt
  const out: Record<string, unknown> = {
    id,
    generation_id: id,
    polling_url: `${API}/videos/${id}`,
  }
  if (age < (job.slow ? 20_000 : 1_500)) return { ...out, status: "pending" }
  if (age < (job.slow ? 26_000 : 6_000))
    return { ...out, status: "in_progress", progress: 40 }
  if (job.outcome === "failed")
    return {
      ...out,
      status: "failed",
      error: "Content policy violation (mock)",
    }
  const seconds = Number(job.body.duration ?? 4) || 4
  const perSecond = String(job.body.model).includes("mini") ? 0.0336 : 0.1028
  return {
    ...out,
    status: "completed",
    unsigned_urls: [`${API}/videos/${id}/content?index=0`],
    // Roughly 480p 16:9 prices per second, so the cost log has realistic numbers.
    usage: {
      cost: Number((perSecond * seconds).toFixed(4)),
      is_byok: false,
    },
  }
}

/** Fire the callback once a job is terminal (the real service retries; we don't). */
async function notify(id: string, job: Job) {
  if (!job.callback || job.notified) return
  const state = snapshot(id, job)
  if (state.status !== "completed" && state.status !== "failed") return
  job.notified = true
  try {
    await fetch(job.callback, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openrouter-idempotency-key": `${id}-${state.status}`,
      },
      body: JSON.stringify({
        type: `video.generation.${state.status}`,
        created_at: new Date().toISOString(),
        data: {
          id,
          status: state.status,
          generation_id: id,
          model: job.body.model ?? null,
          unsigned_urls: state.unsigned_urls,
          usage: state.usage,
          error: state.error,
        },
      }),
    })
  } catch {
    /* the reconciler will pick it up */
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN)
  const method = req.method ?? "GET"
  try {
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? "")) {
      // The model list is public; everything else needs the key.
      if (!(method === "GET" && url.pathname === "/api/v1/videos/models"))
        return fail(res, 401, "Missing Authentication header")
    }
    if (method === "GET" && url.pathname === "/api/v1/videos/models")
      return send(res, 200, { data: [] })

    if (method === "POST" && url.pathname === "/api/v1/videos") {
      const body = JSON.parse(
        (await readBody(req)).toString() || "{}"
      ) as Record<string, unknown>
      const prompt = typeof body.prompt === "string" ? body.prompt : ""
      if (typeof body.model !== "string" || !body.model)
        return fail(res, 400, "model is required")
      if (!prompt && !body.frame_images)
        return fail(res, 400, "prompt is required without frame_images")
      const problem = imageProblem(body)
      if (problem) return fail(res, 400, problem)
      if (prompt.includes("[402]"))
        return fail(
          res,
          402,
          "Insufficient credits. Add more using https://openrouter.ai/credits"
        )
      const id = newId()
      const job: Job = {
        body,
        callback:
          typeof body.callback_url === "string" ? body.callback_url : undefined,
        createdAt: Date.now(),
        outcome: prompt.includes("[fail]") ? "failed" : "completed",
        slow: prompt.includes("[slow]"),
        notified: false,
      }
      jobs.set(id, job)
      setTimeout(() => void notify(id, job), job.slow ? 26_500 : 6_500)
      console.log(
        `[mock] ${String(body.model)} ${String(body.resolution ?? "")} ${String(body.duration ?? "")}s → ${id}`
      )
      return send(res, 202, {
        id,
        generation_id: id,
        polling_url: `${API}/videos/${id}`,
        status: "pending",
      })
    }

    const poll = url.pathname.match(/^\/api\/v1\/videos\/([^/]+)$/)
    if (method === "GET" && poll) {
      const job = jobs.get(poll[1]!)
      return job
        ? send(res, 200, snapshot(poll[1]!, job))
        : fail(res, 404, "Resource not found")
    }

    const content = url.pathname.match(/^\/api\/v1\/videos\/([^/]+)\/content$/)
    if (method === "GET" && content) {
      const job = jobs.get(content[1]!)
      if (!job || snapshot(content[1]!, job).status !== "completed")
        return fail(res, 404, "Resource not found")
      const seed = [...content[1]!].reduce((sum, c) => sum + c.charCodeAt(0), 0)
      const file = readFileSync(join(LOOPS, videos[seed % videos.length]!))
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": file.length,
      })
      return res.end(file)
    }
    return fail(res, 404, "Not found")
  } catch (error) {
    console.error(error)
    return fail(res, 500, "Mock error")
  }
})

server.listen(PORT, () =>
  console.log(`Mock OpenRouter API on ${API} (${videos.length} sample videos)`)
)
