import { env } from "@/lib/env"
import { acceptProviderWebhook } from "@/lib/generations/webhook"
import { asRecord } from "@/lib/higgsfield/client"
import { verifyWebhookToken } from "@/lib/higgsfield/webhook"
import { json } from "@/lib/http"

export const runtime = "nodejs"

const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"])
const REQUEST_ID = /^[a-f0-9-]{8,64}$/i

/**
 * Higgsfield completion webhook (docs: how-to/webhooks). The URL carries the
 * generation id and an HMAC token; the payload itself is never trusted —
 * finalizeGeneration re-fetches the status. Replies fast (< 10 s) and does the
 * copy work after the response (see acceptProviderWebhook).
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const gid = url.searchParams.get("gid") ?? ""
  const token = url.searchParams.get("t") ?? ""
  const secret = env().HF_WEBHOOK_SECRET
  if (!secret || !verifyWebhookToken(gid, token, secret))
    return json({ error: "Invalid webhook token" }, 401)

  const envelope = asRecord(await request.json().catch(() => null))
  const requestId = envelope.request_id
  const status = envelope.status
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID.test(requestId) ||
    typeof status !== "string" ||
    !TERMINAL.has(status)
  )
    return json({ error: "Invalid webhook envelope" }, 400)

  return json(
    await acceptProviderWebhook({
      platform: "higgsfield",
      generationId: gid,
      requestId,
      status,
    })
  )
}
