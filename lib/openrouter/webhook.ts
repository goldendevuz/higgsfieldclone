import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"

import {
  env,
  openRouterWebhookBaseUrl,
  openRouterWebhookSecret,
} from "@/lib/env"

/**
 * OpenRouter's callback (`callback_url`, must be HTTPS) POSTs an event
 * envelope `{type: "video.generation.<status>", data: {id, status, …}}`
 * (https://openrouter.ai/docs/guides/overview/multimodal/video-generation).
 * Signing needs a workspace secret we don't require, so — exactly as for
 * Higgsfield — the URL carries the generation id and an HMAC of it, compared
 * in constant time, and the payload is never trusted: finalizeGeneration
 * re-fetches GET /videos/{id}. (The token is domain-separated from
 * Higgsfield's, so one provider's URL never verifies on the other's route.)
 */
export function openRouterWebhookToken(
  generationId: string,
  secret: string
): string {
  return createHmac("sha256", secret)
    .update(`openrouter|${generationId}`)
    .digest("hex")
}

export function verifyOpenRouterWebhookToken(
  generationId: string,
  token: string,
  secret: string
): boolean {
  if (!/^[a-f0-9]{24}$/.test(generationId) || !/^[a-f0-9]{64}$/.test(token))
    return false
  const expected = Buffer.from(
    openRouterWebhookToken(generationId, secret),
    "hex"
  )
  const given = Buffer.from(token, "hex")
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** `callback_url` for a generation, or undefined when callbacks are off. */
export function openRouterCallbackUrlFor(
  generationId: string
): string | undefined {
  const value = env()
  const base = openRouterWebhookBaseUrl(value)
  const secret = openRouterWebhookSecret(value)
  if (!base || !secret) return undefined
  const url = new URL("/api/webhooks/openrouter", base)
  // OpenRouter only accepts HTTPS callbacks; plain http is for the local mock.
  if (url.protocol !== "https:" && value.NODE_ENV === "production")
    return undefined
  // The real OpenRouter rejects http and localhost callbacks ("Localhost URLs
  // are not allowed"): skip the callback, the reconciler finishes the run.
  const realApi =
    new URL(value.OPENROUTER_API_BASE_URL).hostname === "openrouter.ai"
  const local =
    /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/.test(
      url.hostname
    ) || url.hostname.endsWith(".local")
  if (realApi && (url.protocol !== "https:" || local)) return undefined
  url.searchParams.set("gid", generationId)
  url.searchParams.set("t", openRouterWebhookToken(generationId, secret))
  return url.toString()
}
