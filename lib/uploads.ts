import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"

import { ObjectId } from "mongodb"
import { z } from "zod"

import {
  mediaKindFromMime,
  requireUploadContentType,
  type UploadTicket,
} from "@/generation/upload-contract"
import type { MediaKind } from "@/generation/catalog/types"
import { UserFacingError } from "@/lib/errors"
import type { SessionUser } from "@/lib/auth/session"
import { objectIdOrNotFound } from "@/lib/ids"
import { NotFoundError } from "@/lib/errors"
import { collections, type UploadDoc } from "@/lib/db/collections"
import { env, providersConfigured } from "@/lib/env"
import { toUploadView } from "@/lib/generations/serialize"
import type { UploadView } from "@/lib/generations/view"
import { higgsfield } from "@/lib/higgsfield/client"
import { enforceRateLimit, LIMITS } from "@/lib/rate-limit"
import {
  copyFromUrl,
  deleteObjects,
  MediaTooLargeError,
  publicUrlFor,
  putObject,
  readCapped,
  storageDriver,
} from "@/lib/storage"
import { probeMedia } from "@/lib/storage/probe"

/**
 * Reference uploads: the server asks the platform for a signed upload URL
 * (POST /files/generate-upload-url, docs: concepts/file-uploads), the browser
 * PUTs the file straight there, then confirms. The ticket's public URL is
 * HMAC-signed so confirm only ever fetches URLs the platform issued to this
 * user (no server-side request forgery). Signed upload URLs are never logged.
 */

export const MAX_UPLOAD_BYTES: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
}

const TICKET_TTL_MS = 60 * 60_000

function ticketSecret(): string {
  const secret = env().AUTH_SECRET
  if (secret) return secret
  if (env().NODE_ENV === "production")
    throw new Error("AUTH_SECRET is required")
  return "dev-only-upload-secret"
}

function sign(parts: string[]): string {
  return createHmac("sha256", ticketSecret())
    .update(parts.join("|"))
    .digest("hex")
}

/* ── Direct uploads (no Higgsfield key): our own signed PUT endpoint ─────── */

const DIRECT_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
}

function directSignature(key: string, contentType: string, expires: string) {
  return sign(["direct-upload", key, contentType, expires])
}

/** A ticket whose upload URL is our own endpoint (app/api/upload/direct). */
function directUploadTicket(
  user: SessionUser,
  contentType: string
): UploadTicket {
  const key = `u/${user.id}/uploads/${new ObjectId().toHexString()}.${DIRECT_EXTENSION[contentType] ?? "bin"}`
  const expires = String(Date.now() + TICKET_TTL_MS)
  const url = new URL("/api/upload/direct", env().APP_URL)
  url.searchParams.set("k", key)
  url.searchParams.set("c", contentType)
  url.searchParams.set("e", expires)
  url.searchParams.set("s", directSignature(key, contentType, expires))
  return {
    upload_url: url.toString(),
    public_url: publicUrlFor(key),
    content_type: contentType,
    upload_headers: { "Content-Type": contentType },
  }
}

/**
 * Verify a direct-upload URL's signature and write the body to storage.
 * Called by PUT /api/upload/direct, which has no session (the browser sends
 * no credentials to upload URLs): the signed key already names the user.
 */
export async function receiveDirectUpload(
  params: URLSearchParams,
  headerContentType: string | null,
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  const key = params.get("k") ?? ""
  const contentType = params.get("c") ?? ""
  const expires = params.get("e") ?? ""
  const signature = params.get("s") ?? ""
  if (!/^u\/[a-f0-9]{24}\/uploads\/[a-f0-9]{24}\.[a-z0-9]{2,4}$/.test(key))
    throw new UserFacingError("Invalid upload.", "BAD_TICKET")
  if (!/^[a-f0-9]{64}$/.test(signature) || !/^\d+$/.test(expires))
    throw new UserFacingError("Invalid upload.", "BAD_TICKET")
  const expected = Buffer.from(
    directSignature(key, contentType, expires),
    "hex"
  )
  const given = Buffer.from(signature, "hex")
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw new UserFacingError("Invalid upload.", "BAD_TICKET")
  if (Number(expires) < Date.now())
    throw new UserFacingError(
      "This upload expired. Upload the file again.",
      "EXPIRED"
    )
  if (headerContentType?.split(";")[0]?.trim() !== contentType || !body)
    throw new UserFacingError("Invalid upload.", "BAD_TICKET")
  const kind = mediaKindFromMime(requireUploadContentType(contentType))
  try {
    const bytes = await readCapped(body, MAX_UPLOAD_BYTES[kind])
    await putObject(key, bytes, contentType)
  } catch (caught) {
    if (caught instanceof MediaTooLargeError)
      throw new UserFacingError(
        "That file is larger than the upload limit.",
        "TOO_LARGE"
      )
    throw caught
  }
}

/** The storage key behind one of our own public URLs for this user's uploads, if it is one. */
function ownUploadKey(publicUrl: string, userId: string): string | undefined {
  const prefix = publicUrlFor(`u/${userId}/uploads/`)
  if (!publicUrl.startsWith(prefix)) return undefined
  const rest = publicUrl.slice(prefix.length)
  return /^[a-f0-9]{24}\.[a-z0-9]{2,4}$/.test(rest)
    ? `u/${userId}/uploads/${rest}`
    : undefined
}

export const ticketRequestSchema = z.object({
  contentType: z.string(),
  size: z.number().int().positive(),
  name: z.string().max(200).default("upload"),
})

export async function createUploadTicket(user: SessionUser, raw: unknown) {
  const input = ticketRequestSchema.parse(raw)
  let contentType: string
  try {
    contentType = requireUploadContentType(input.contentType)
  } catch (caught) {
    throw new UserFacingError((caught as Error).message, "UNSUPPORTED_TYPE")
  }
  const kind = mediaKindFromMime(contentType)
  if (input.size > MAX_UPLOAD_BYTES[kind])
    throw new UserFacingError(
      `${kind[0]!.toUpperCase()}${kind.slice(1)} files can be up to ${Math.round(
        MAX_UPLOAD_BYTES[kind] / 1024 / 1024
      )} MB.`,
      "TOO_LARGE"
    )
  await enforceRateLimit(
    `upload:${user.id}`,
    LIMITS.uploadPerUser.limit,
    LIMITS.uploadPerUser.window,
    "Too many uploads. Wait a few minutes and try again."
  )
  // With a Higgsfield key the platform issues the upload URL (original flow).
  // Without one (OpenRouter-only), uploads go through our own signed endpoint
  // into our storage: OpenRouter has no upload API and needs https URLs.
  const ticket = providersConfigured().higgsfield
    ? await higgsfield().createUpload(contentType)
    : directUploadTicket(user, contentType)
  const expires = Date.now() + TICKET_TTL_MS
  return {
    ticket,
    token: `${expires}.${sign([user.id, ticket.public_url, contentType, String(expires)])}`,
  }
}

export const recordSchema = z.object({
  publicUrl: z.url(),
  contentType: z.string(),
  name: z.string().max(200).default("upload"),
  size: z.number().int().positive(),
  token: z.string().regex(/^\d+\.[a-f0-9]{64}$/),
})

function verifyTicket(
  user: SessionUser,
  input: z.infer<typeof recordSchema>
): void {
  const [expires, signature] = input.token.split(".")
  if (Number(expires) < Date.now())
    throw new UserFacingError(
      "This upload expired. Upload the file again.",
      "EXPIRED"
    )
  const expected = Buffer.from(
    sign([user.id, input.publicUrl, input.contentType, expires!]),
    "hex"
  )
  const given = Buffer.from(signature!, "hex")
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw new UserFacingError(
      "Upload could not be verified. Try again.",
      "BAD_TICKET"
    )
}

/** Fetch a stored file and record its size and media facts (duration, dimensions). */
async function probeInto(
  doc: UploadDoc,
  url: string,
  kind: MediaKind,
  contentType: string
): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok || !response.body) return
  const buffer = await readCapped(response.body, MAX_UPLOAD_BYTES[kind])
  Object.assign(doc, { bytes: buffer.length }, probeMedia(buffer, contentType))
}

export async function recordUpload(
  user: SessionUser,
  raw: unknown
): Promise<UploadView> {
  const input = recordSchema.parse(raw)
  verifyTicket(user, input)
  const contentType = requireUploadContentType(input.contentType)
  const kind = mediaKindFromMime(contentType)
  const { uploads } = await collections()
  const existing = await uploads.findOne({
    userId: user.objectId,
    platformUrl: input.publicUrl,
  })
  if (existing) return toUploadView(existing)

  const id = new ObjectId()
  const doc: UploadDoc = {
    _id: id,
    userId: user.objectId,
    kind,
    url: input.publicUrl,
    platformUrl: input.publicUrl,
    contentType,
    bytes: input.size,
    name: input.name.slice(0, 120),
    createdAt: new Date(),
  }
  const ownKey = ownUploadKey(input.publicUrl, user.id)
  try {
    if (ownKey) {
      // Direct upload: already in our storage; just probe it.
      doc.key = ownKey
      await probeInto(doc, input.publicUrl, kind, contentType)
    } else if (storageDriver() === "r2") {
      // Platform uploads are tagged temporary; keep our own copy for the library.
      const stored = await copyFromUrl(
        input.publicUrl,
        `u/${user.id}/uploads/${id.toHexString()}`,
        { contentType, maxBytes: MAX_UPLOAD_BYTES[kind] }
      )
      Object.assign(doc, {
        url: stored.url,
        key: stored.key,
        bytes: stored.bytes,
        ...(stored.width ? { width: stored.width } : {}),
        ...(stored.height ? { height: stored.height } : {}),
        ...(stored.durationSec ? { durationSec: stored.durationSec } : {}),
      })
    } else {
      // Local dev: the platform can't fetch localhost, so keep its URL and probe only.
      await probeInto(doc, input.publicUrl, kind, contentType)
    }
  } catch (caught) {
    if (caught instanceof MediaTooLargeError)
      throw new UserFacingError(
        "That file is larger than the upload limit.",
        "TOO_LARGE"
      )
    console.error(
      "[uploads] copy/probe failed; keeping platform URL",
      (caught as Error).message
    )
  }
  await uploads.insertOne(doc)
  return toUploadView(doc)
}

export async function listUploads(
  userId: ObjectId,
  limit = 200
): Promise<UploadView[]> {
  const { uploads } = await collections()
  const docs = await uploads
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray()
  return docs.map(toUploadView)
}

export async function deleteUpload(
  userId: ObjectId,
  id: string
): Promise<void> {
  const { uploads } = await collections()
  const doc = await uploads.findOne({ _id: objectIdOrNotFound(id), userId })
  if (!doc) throw new NotFoundError("Upload not found.")
  if (doc.key) await deleteObjects([doc.key]).catch(() => undefined)
  await uploads.deleteOne({ _id: doc._id, userId })
}
