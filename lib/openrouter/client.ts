import "server-only"

import { env } from "@/lib/env"
import {
  AmbiguousSubmitError,
  asRecord,
  isAllowedMediaUrl,
} from "@/lib/higgsfield/client"
import type { PlatformArtifact, RequestStatus } from "@/lib/higgsfield/types"

import type { MappedStatus, SubmittedJob } from "./types"

/**
 * Thin server-side client for OpenRouter's video API:
 *   POST {base}/videos            submit (202 + id, polling_url, status)
 *   GET  {base}/videos/{id}       poll   (status, unsigned_urls, usage.cost)
 *   GET  {base}/videos/{id}/content?index=N   download (needs the key)
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/video-generation
 *
 * Same rules as the Higgsfield client: one key from the environment
 * (`Authorization: Bearer`), jittered exponential backoff for safe calls, and
 * NO automatic retry of an ambiguous submit — the API takes no idempotency
 * key, so a retry after a timeout could create (and bill) a second video.
 * The key is only ever sent to the configured API origin.
 */

export class OpenRouterError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(messageFromBody(status, body))
    this.name = "OpenRouterError"
    this.status = status
    this.body = body
  }
}

export class OpenRouterNotConfiguredError extends Error {
  constructor() {
    super("OPENROUTER_API_KEY is not set, so OpenRouter models are disabled.")
    this.name = "OpenRouterNotConfiguredError"
  }
}

export type OpenRouterClientOptions = {
  apiKey: string
  baseUrl: string
  fetch?: typeof fetch
  /** Per-attempt timeout. */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Answers that prove nothing was created, so a submit may be retried. */
const SUBMIT_RETRY = new Set([429, 503])
/** Statuses where a submit may or may not have been accepted. */
const AMBIGUOUS_SUBMIT = new Set([500, 502, 504])
const SAFE_RETRY = new Set([429, 500, 502, 503, 504])
/** A job id is `gen-vid-<ts>-<20 alphanumerics>` (older ones are shorter ids). */
const JOB_ID = /^[A-Za-z0-9_-]{6,80}$/

export function isJobId(id: string): boolean {
  return JOB_ID.test(id)
}

export function createOpenRouterClient(options: OpenRouterClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "")
  const base = new URL(baseUrl)
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  if (!options.apiKey.trim()) throw new Error("OPENROUTER_API_KEY is empty")
  const authorization = `Bearer ${options.apiKey}`

  async function once(
    method: "GET" | "POST",
    url: string,
    body?: Record<string, unknown>
  ): Promise<{ status: number; payload: unknown; retryAfterMs?: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        cache: "no-store",
        // The key must not follow a redirect to another origin.
        redirect: "error",
      })
      const seconds = Number(response.headers.get("retry-after"))
      return {
        status: response.status,
        payload: await readJson(response),
        ...(Number.isFinite(seconds) && seconds > 0
          ? { retryAfterMs: Math.min(seconds * 1000, 10_000) }
          : {}),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Retries network errors and retryable statuses with full-jitter backoff. */
  async function withRetry(
    method: "GET" | "POST",
    url: string,
    body: Record<string, unknown> | undefined,
    retryable: Set<number>,
    retryNetwork: boolean,
    attempts = 3
  ): Promise<unknown> {
    let lastError: unknown
    let wait: number | undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(wait ?? Math.random() * 400 * 2 ** attempt)
      wait = undefined
      try {
        const result = await once(method, url, body)
        if (result.status >= 200 && result.status < 300) return result.payload
        const error = new OpenRouterError(result.status, result.payload)
        if (!retryable.has(result.status)) throw error
        wait = result.retryAfterMs
        lastError = error
      } catch (caught) {
        if (caught instanceof OpenRouterError) throw caught
        if (!retryNetwork) throw new AmbiguousSubmitError(caught)
        lastError = caught
      }
    }
    throw lastError
  }

  /** Content URLs are only trusted (and sent the key) on the API origin. */
  function isApiUrl(url: string): boolean {
    try {
      return new URL(url).origin === base.origin
    } catch {
      return false
    }
  }

  function resolveUrl(url: string): string {
    try {
      return new URL(url, `${base.origin}/`).toString()
    } catch {
      return url
    }
  }

  return {
    /** POST /videos. Retries only answers that prove nothing was created. */
    async submit(
      body: Record<string, unknown>,
      callbackUrl?: string
    ): Promise<SubmittedJob> {
      const payload = {
        ...body,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      }
      try {
        return mapSubmitted(
          await withRetry(
            "POST",
            `${baseUrl}/videos`,
            payload,
            SUBMIT_RETRY,
            false
          )
        )
      } catch (caught) {
        if (
          caught instanceof OpenRouterError &&
          AMBIGUOUS_SUBMIT.has(caught.status)
        )
          throw new AmbiguousSubmitError(caught)
        throw caught
      }
    },

    /** GET /videos/{id}, mapped into our status shape. */
    async status(id: string): Promise<RequestStatus> {
      if (!isJobId(id)) throw new OpenRouterError(400, "Invalid job id")
      const payload = await withRetry(
        "GET",
        `${baseUrl}/videos/${encodeURIComponent(id)}`,
        undefined,
        SAFE_RETRY,
        true
      )
      return mapJob(payload, id, baseUrl, resolveUrl)
    },

    /** Headers for downloading `url`: the key goes only to the API origin. */
    mediaHeaders(url: string): Record<string, string> | undefined {
      return isApiUrl(url) ? { Authorization: authorization } : undefined
    },

    contentUrl(id: string, index = 0): string {
      return `${baseUrl}/videos/${encodeURIComponent(id)}/content?index=${index}`
    },
  }
}

export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>

let shared: OpenRouterClient | undefined

/** The client configured from env; throws when unconfigured. */
export function openrouter(): OpenRouterClient {
  if (shared) return shared
  const value = env()
  if (!value.OPENROUTER_API_KEY) throw new OpenRouterNotConfiguredError()
  shared = createOpenRouterClient({
    apiKey: value.OPENROUTER_API_KEY,
    baseUrl: value.OPENROUTER_API_BASE_URL,
  })
  return shared
}

/** Tests inject a client backed by a fake fetch. */
export function setOpenRouterClientForTests(client?: OpenRouterClient): void {
  shared = client
}

/* ── Response mapping ─────────────────────────────────────────────────────── */

/**
 * pending → queued, in_progress → in_progress, completed → completed,
 * failed and expired → failed (refunded once), cancelled → canceled.
 * Anything else is "unknown" and treated as still running.
 */
export function mapJobStatus(status: unknown): MappedStatus {
  switch (status) {
    case "pending":
      return "queued"
    case "in_progress":
      return "in_progress"
    case "completed":
      return "completed"
    case "failed":
    case "expired":
      return "failed"
    case "cancelled":
      return "canceled"
    default:
      return "unknown"
  }
}

function mapSubmitted(payload: unknown): SubmittedJob {
  const data = asRecord(payload)
  const id = typeof data.id === "string" ? data.id : undefined
  if (!id || !isJobId(id))
    throw new AmbiguousSubmitError(
      new OpenRouterError(502, "Response missing a valid job id")
    )
  return {
    id,
    ...(typeof data.generation_id === "string"
      ? { generationId: data.generation_id }
      : {}),
    pollingUrl: typeof data.polling_url === "string" ? data.polling_url : "",
    status: typeof data.status === "string" ? data.status : "pending",
  }
}

/** Poll (or webhook `data`) payload → status, artifacts, cost. */
export function mapJob(
  payload: unknown,
  id: string,
  baseUrl: string,
  resolveUrl: (url: string) => string = (url) => url
): RequestStatus {
  const data = asRecord(payload)
  const status = mapJobStatus(data.status)
  const error = data.error
  const cost = asRecord(data.usage).cost
  return {
    status,
    requestId: id,
    artifacts:
      status === "completed" ? artifactsOf(data, id, baseUrl, resolveUrl) : [],
    ...(typeof error === "string" && error ? { error } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { costUsd: cost }
      : {}),
  }
}

function artifactsOf(
  data: Record<string, unknown>,
  id: string,
  baseUrl: string,
  resolveUrl: (url: string) => string
): PlatformArtifact[] {
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  const signed = strings(data.urls)
  const listed = strings(data.unsigned_urls)
    .map(resolveUrl)
    .map((url, index) => ({ url, index }))
    .filter(({ url }) => isAllowedMediaUrl(url))
  // A completed job without (usable) listed URLs is still downloadable from
  // the documented /content endpoint on the API origin.
  const sources = listed.length
    ? listed
    : [
        {
          url: `${baseUrl}/videos/${encodeURIComponent(id)}/content?index=0`,
          index: 0,
        },
      ]
  const out: PlatformArtifact[] = []
  for (const { url, index } of sources) {
    if (!isAllowedMediaUrl(url)) continue
    const fallback = signed[index]
    out.push({
      kind: "video",
      url,
      contentType: "video/mp4",
      authorized: true,
      ...(fallback && isAllowedMediaUrl(fallback)
        ? { fallbackUrl: fallback }
        : {}),
    })
  }
  return out
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function messageFromBody(status: number, body: unknown): string {
  const error = asRecord(body).error
  const message =
    typeof error === "string"
      ? error
      : typeof asRecord(error).message === "string"
        ? (asRecord(error).message as string)
        : undefined
  return message || `OpenRouter request failed (${status})`
}
