import "server-only"

import { platformOf } from "@/generation/catalog"
import type { ModelEntry, ModelPlatform } from "@/generation/catalog/types"
import {
  loadUserKey,
  PROVIDER_LABEL,
  UserKeyMissingError,
} from "@/lib/byok/keys"
import {
  keySourceOf,
  platformOfDoc,
  type GenerationDoc,
  type KeySource,
} from "@/lib/db/collections"
import { providersConfigured, env } from "@/lib/env"
import { UserFacingError } from "@/lib/errors"
import {
  createHiggsfieldClient,
  higgsfield,
  PlatformError,
  type HiggsfieldClient,
} from "@/lib/higgsfield/client"
import {
  createOpenRouterClient,
  openrouter,
  OpenRouterError,
  type OpenRouterClient,
} from "@/lib/openrouter/client"
import { userKeyPlatforms } from "@/lib/byok/keys"
import type { ObjectId } from "mongodb"

/**
 * Which key runs a generation, and the provider client for it.
 *
 * A new generation uses the user's own key for the platform when they have one
 * (they pay the provider directly, no credits), else the server key (credits as
 * always), else the model is inactive. The choice is stored on the generation
 * as `keySource`; every later call (status, download, cancel) resolves its
 * client from the generation's own `userId` + `keySource` here and never
 * falls back to another key.
 */

/** The key a new generation of `platform` would use for this user, or null. */
export async function chooseKeySource(
  userId: ObjectId,
  platform: ModelPlatform
): Promise<KeySource | null> {
  if ((await userKeyPlatforms(userId)).includes(platform)) return "user"
  return providersConfigured()[platform] ? "server" : null
}

export function needsKeyMessage(model: Pick<ModelEntry, "platform" | "label">) {
  return `${model.label} needs your own ${PROVIDER_LABEL[platformOf(model)]} key. Connect it under Account → API keys.`
}

type Owner = Pick<GenerationDoc, "userId" | "platform" | "keySource">

export async function openrouterFor(gen: Owner): Promise<OpenRouterClient> {
  if (keySourceOf(gen) === "server") return openrouter()
  return createOpenRouterClient({
    apiKey: await loadUserKey(gen.userId, "openrouter"),
    baseUrl: env().OPENROUTER_API_BASE_URL,
  })
}

export async function higgsfieldFor(gen: Owner): Promise<HiggsfieldClient> {
  if (keySourceOf(gen) === "server") return higgsfield()
  return createHiggsfieldClient({
    credentials: await loadUserKey(gen.userId, "higgsfield"),
    baseUrl: env().HF_API_BASE_URL,
  })
}

/** Status of a job from the provider and key that submitted it. */
export async function statusFor(gen: GenerationDoc, requestId: string) {
  return platformOfDoc(gen) === "openrouter"
    ? (await openrouterFor(gen)).status(requestId)
    : (await higgsfieldFor(gen)).status(requestId)
}

/** Safe, user-facing text when the stored key can't be used for a job any more. */
export function keyGoneMessage(error: UserKeyMissingError): string {
  const name = PROVIDER_LABEL[error.provider]
  return error.reason === "missing"
    ? `This generation ran on your ${name} key, which you have since removed, so we can't fetch the result. Check your ${name} dashboard; nothing was charged here.`
    : `This generation ran on your ${name} key, which we can't read right now, so we can't fetch the result. Reconnect the key under Account → API keys; nothing was charged here.`
}

/**
 * A provider failure on the user's own key, in words about their key. Never
 * an operator alert: the platform's own key is not involved.
 */
export function describeUserKeyFailure(
  platform: ModelPlatform,
  caught: unknown
): string | undefined {
  const name = PROVIDER_LABEL[platform]
  const status =
    caught instanceof OpenRouterError || caught instanceof PlatformError
      ? caught.status
      : undefined
  if (caught instanceof UserKeyMissingError)
    return `Your ${name} key is no longer available. Reconnect it under Account → API keys.`
  if (status === 401 || status === 403)
    return `${name} rejected your key (${status}). Check it under Account → API keys.`
  if (status === 402)
    return `Your ${name} account is out of credits. Top it up there and try again.`
  return undefined
}

/** For callers that must refuse a user-key job on an action the key can't do. */
export function userKeyActionError(
  error: UserKeyMissingError
): UserFacingError {
  return new UserFacingError(keyGoneMessage(error), "KEY_GONE")
}
