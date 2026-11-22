import "server-only"

import { asRecord } from "@/lib/higgsfield/client"

/**
 * OpenRouter takes frame and reference images as https URLs or base64 data
 * URLs (https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
 * and has no upload endpoint. In production our files sit on R2 behind public
 * https URLs and pass through untouched. In local development they live on
 * localhost, which OpenRouter can't reach, so those few images are inlined as
 * data URLs just before the request is sent. The inlined body is never stored
 * (generation documents keep the URL).
 */

/** Largest image we inline; larger ones would risk a 413 from the API. */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024

/** A user-readable reason an attachment can't be sent. */
export class InlineMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InlineMediaError"
  }
}

type ImageHolder = { image_url?: { url?: unknown } }

function imageUrlHolders(body: Record<string, unknown>): ImageHolder[] {
  const holders: ImageHolder[] = []
  for (const key of ["frame_images", "input_references"]) {
    const list = body[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const record = asRecord(item)
      if (record.type === "image_url" || record.image_url)
        holders.push(record as ImageHolder)
    }
  }
  return holders
}

async function toDataUrl(
  url: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const response = await fetchImpl(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new InlineMediaError(
      "One of your images couldn't be read. Remove it and add it again."
    )
  const type = response.headers.get("content-type")?.split(";")[0]?.trim()
  if (!type || !type.startsWith("image/"))
    throw new InlineMediaError(
      "Only image attachments can be sent to this model."
    )
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_INLINE_IMAGE_BYTES)
    throw new InlineMediaError(
      "An attached image is too large for this model. Use one under 8 MB."
    )
  return `data:${type};base64,${bytes.toString("base64")}`
}

/** Copy of `body` where every non-https image URL is replaced by a data URL. */
export async function withSendableMedia(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const copy = structuredClone(body)
  for (const holder of imageUrlHolders(copy)) {
    const url = holder.image_url?.url
    if (typeof url !== "string" || url.startsWith("https://")) continue
    if (url.startsWith("data:")) continue
    holder.image_url!.url = await toDataUrl(url, fetchImpl)
  }
  return copy
}
