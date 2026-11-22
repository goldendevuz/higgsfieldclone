import "server-only"

import type { ObjectId } from "mongodb"

import type { ModelPlatform } from "@/generation/catalog/types"
import { collections } from "@/lib/db/collections"
import { byokEncryptionKey, env } from "@/lib/env"
import { UserFacingError } from "@/lib/errors"
import { enforceRateLimit, LIMITS } from "@/lib/rate-limit"

import type { KeyStatus } from "./keys-types"
import { decryptSecret, encryptSecret, KeyDecryptError, keyAad } from "./crypto"

/**
 * Users' own provider keys (BYOK). The plaintext exists only in this module's
 * save path and in the server-side client that makes a provider call; it is
 * never returned by an action, a page prop or a log line (`redactSecrets`).
 */

export const PROVIDERS = [
  "openrouter",
  "higgsfield",
] as const satisfies readonly ModelPlatform[]

export const PROVIDER_LABEL: Record<ModelPlatform, string> = {
  openrouter: "OpenRouter",
  higgsfield: "Higgsfield",
}

export type { KeyStatus } from "./keys-types"

/** The user's key is gone (deleted) or can't be read (encryption key changed). */
export class UserKeyMissingError extends Error {
  constructor(
    readonly provider: ModelPlatform,
    readonly reason: "missing" | "unreadable" = "missing"
  ) {
    super(`No usable ${provider} key for this account (${reason}).`)
    this.name = "UserKeyMissingError"
  }
}

/* ── Validation ───────────────────────────────────────────────────────── */

const OPENROUTER_FORMAT = /^[A-Za-z0-9_.-]{8,200}$/
const HIGGSFIELD_FORMAT = /^[^:\s]{1,120}:[^:\s]{1,200}$/

/** Trim and check the shape of a pasted key; throws a message for the form. */
export function normalizeKey(provider: ModelPlatform, raw: string): string {
  const key = raw.trim()
  if (!key) throw new UserFacingError("Paste a key first.", "INVALID_KEY")
  if (provider === "openrouter" && !OPENROUTER_FORMAT.test(key))
    throw new UserFacingError(
      "That doesn't look like an OpenRouter key (it starts with sk-or-).",
      "INVALID_KEY"
    )
  if (provider === "higgsfield" && !HIGGSFIELD_FORMAT.test(key))
    throw new UserFacingError(
      "Higgsfield credentials look like key_id:key_secret.",
      "INVALID_KEY"
    )
  return key
}

/**
 * Mask anything that looks like a credential, for logs and messages. The
 * server never logs a user's key on purpose; this is the belt to those braces.
 */
export function redactSecrets(text: string, ...secrets: string[]): string {
  let out = text
  for (const secret of secrets)
    if (secret.length >= 6) out = out.split(secret).join("[redacted]")
  return out
    .replace(/\b(Bearer|Key)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(/\bsk-or-[A-Za-z0-9_-]+/g, "sk-or-[redacted]")
}

/**
 * Ask the provider whether the key works. OpenRouter documents a harmless
 * `GET /key` (https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key).
 * Higgsfield's repo docs describe no read-only account or credits endpoint, so
 * its credentials are checked for format only (`verified: false`) and fail at
 * the first generation if wrong.
 */
export async function verifyKey(
  provider: ModelPlatform,
  key: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ verified: boolean }> {
  if (provider === "higgsfield") return { verified: false }
  const base = env().OPENROUTER_API_BASE_URL.replace(/\/$/, "")
  let status: number
  try {
    const response = await fetchImpl(`${base}/key`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    })
    status = response.status
    await response.body?.cancel().catch(() => undefined)
  } catch {
    throw new UserFacingError(
      "Couldn't reach OpenRouter to check the key. Try again in a moment.",
      "KEY_CHECK_FAILED"
    )
  }
  if (status >= 200 && status < 300) return { verified: true }
  if (status === 401 || status === 403)
    throw new UserFacingError(
      "OpenRouter rejected this key. Check it and try again.",
      "KEY_REJECTED"
    )
  throw new UserFacingError(
    "OpenRouter couldn't check this key right now. Try again in a moment.",
    "KEY_CHECK_FAILED"
  )
}

/* ── Storage ──────────────────────────────────────────────────────────── */

/** True when keys can be stored and read on this deployment. */
export function byokEnabled(): boolean {
  return byokEncryptionKey() !== undefined
}

function requireEncryptionKey(): Buffer {
  const key = byokEncryptionKey()
  if (!key)
    throw new UserFacingError(
      "Saving your own keys is not enabled on this server (BYOK_ENCRYPTION_KEY is not set).",
      "BYOK_NOT_CONFIGURED"
    )
  return key
}

const toStatus = (doc: {
  provider: ModelPlatform
  last4: string
  verified: boolean
  createdAt: Date
  lastUsedAt?: Date
}): KeyStatus => ({
  provider: doc.provider,
  last4: doc.last4,
  verified: doc.verified,
  createdAt: doc.createdAt.getTime(),
  ...(doc.lastUsedAt ? { lastUsedAt: doc.lastUsedAt.getTime() } : {}),
})

/** Validate, encrypt and store (or replace) the user's key for a provider. */
export async function saveUserKey(
  userId: ObjectId,
  provider: ModelPlatform,
  raw: string,
  fetchImpl: typeof fetch = fetch
): Promise<KeyStatus> {
  const encryptionKey = requireEncryptionKey()
  await enforceRateLimit(
    `keys:${userId.toHexString()}`,
    LIMITS.keysPerUser.limit,
    LIMITS.keysPerUser.window,
    "Too many key changes. Try again in a while."
  )
  const key = normalizeKey(provider, raw)
  const { verified } = await verifyKey(provider, key, fetchImpl)
  const sealed = encryptSecret(
    key,
    encryptionKey,
    keyAad(userId.toHexString(), provider)
  )
  const now = new Date()
  const { userKeys } = await collections()
  const doc = await userKeys.findOneAndUpdate(
    { userId, provider },
    {
      $set: {
        ...sealed,
        last4: key.slice(-4),
        verified,
        updatedAt: now,
      },
      $unset: { lastUsedAt: "" },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, returnDocument: "after" }
  )
  return toStatus(doc!)
}

export async function deleteUserKey(
  userId: ObjectId,
  provider: ModelPlatform
): Promise<void> {
  await enforceRateLimit(
    `keys:${userId.toHexString()}`,
    LIMITS.keysPerUser.limit,
    LIMITS.keysPerUser.window,
    "Too many key changes. Try again in a while."
  )
  const { userKeys } = await collections()
  await userKeys.deleteOne({ userId, provider })
}

/** Status of the user's stored keys (last four characters only). */
export async function listUserKeys(userId: ObjectId): Promise<KeyStatus[]> {
  const { userKeys } = await collections()
  const docs = await userKeys
    .find(
      { userId },
      {
        projection: {
          provider: 1,
          last4: 1,
          verified: 1,
          createdAt: 1,
          lastUsedAt: 1,
        },
      }
    )
    .toArray()
  return docs.map((doc) => toStatus(doc))
}

/** Providers the user has a usable key for (none when encryption isn't configured). */
export async function userKeyPlatforms(
  userId: ObjectId
): Promise<ModelPlatform[]> {
  if (!byokEnabled()) return []
  return (await listUserKeys(userId)).map((status) => status.provider)
}

const TOUCH_AFTER_MS = 10 * 60_000

/**
 * The user's plaintext key for a provider, for one server-side call. Only ever
 * looked up by the generation's own `userId`, so no other account's key (and
 * never the server key) can answer for it.
 */
export async function loadUserKey(
  userId: ObjectId,
  provider: ModelPlatform
): Promise<string> {
  const encryptionKey = byokEncryptionKey()
  const { userKeys } = await collections()
  const doc = await userKeys.findOne({ userId, provider })
  if (!doc) throw new UserKeyMissingError(provider, "missing")
  if (!encryptionKey) throw new UserKeyMissingError(provider, "unreadable")
  let key: string
  try {
    key = decryptSecret(
      doc,
      encryptionKey,
      keyAad(userId.toHexString(), provider)
    )
  } catch (error) {
    if (error instanceof KeyDecryptError)
      throw new UserKeyMissingError(provider, "unreadable")
    throw error
  }
  if (!doc.lastUsedAt || Date.now() - doc.lastUsedAt.getTime() > TOUCH_AFTER_MS)
    await userKeys
      .updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } })
      .catch(() => undefined)
  return key
}
