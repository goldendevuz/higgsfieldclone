import { env, openRouterWebhookSecret, providersConfigured } from "@/lib/env"
import { acceptProviderWebhook } from "@/lib/generations/webhook"
import { asRecord } from "@/lib/higgsfield/client"
import { json } from "@/lib/http"
import { isJobId } from "@/lib/openrouter/client"
import { verifyOpenRouterWebhookToken } from "@/lib/openrouter/webhook"

export const runtime = "nodejs"

/** Terminal webhook statuses; the status is mapped when finalize re-fetches the job. */
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"])

/**
 * OpenRouter video completion webhook (`callback_url`). The envelope is
 * `{type: "video.generation.<status>", data: {id, status, …}}`. The URL
 * carries the generation id and an HMAC token; the payload is never trusted —
 * finalizeGeneration re-fetches GET /videos/{id}. Retries are deduplicated on
 * (job id, status).
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/video-generation
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const gid = url.searchParams.get("gid") ?? ""
  const token = url.searchParams.get("t") ?? ""
  const secret = openRouterWebhookSecret(env())
  if (
    !providersConfigured().openrouter ||
    !secret ||
    !verifyOpenRouterWebhookToken(gid, token, secret)
  )
    return json({ error: "Invalid webhook token" }, 401)

  const envelope = asRecord(await request.json().catch(() => null))
  const data = asRecord(envelope.data)
  const requestId = data.id
  const status = data.status
  if (
    typeof requestId !== "string" ||
    !isJobId(requestId) ||
    typeof status !== "string" ||
    !TERMINAL.has(status)
  )
    return json({ error: "Invalid webhook envelope" }, 400)

  return json(
    await acceptProviderWebhook({
      platform: "openrouter",
      generationId: gid,
      requestId,
      // Same vocabulary as Higgsfield for the late-delivery check.
      status: status === "cancelled" ? "canceled" : status,
    })
  )
}
