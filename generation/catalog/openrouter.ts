import {
  assertFramesOrReferences,
  compact,
  first,
  int,
  promptText,
  unlessAuto,
  urls,
} from "./mappers"
import type { GenerationPlane, PlatformRequest, SettingField } from "./types"

/**
 * Shared pieces for models served through OpenRouter's video API.
 * Sources:
 *   https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request
 *   https://openrouter.ai/docs/guides/overview/multimodal/video-generation
 *   https://openrouter.ai/api/v1/videos/models (supported sizes, durations, prices)
 * One endpoint (POST /api/v1/videos) serves every mode: the body carries
 * `frame_images` (first/last frame) or `input_references`, or neither (text).
 */

/** Pricing key of an OpenRouter model: `openrouter/{slug}` (see lib/openrouter/pricing.ts). */
export function openRouterPath(slug: string): string {
  return `openrouter/${slug}`
}

/** Inverse of `openRouterPath`; undefined for any other path. */
export function openRouterSlug(path: string): string | undefined {
  return path.startsWith("openrouter/")
    ? path.slice("openrouter/".length)
    : undefined
}

const RESOLUTION_LABELS: Readonly<Record<string, string>> = {
  "480p": "480p (draft, cheapest)",
  "720p": "720p (about 2.2x the cost)",
  "1080p": "1080p (about 5.5x the cost)",
}

/**
 * Resolution setting for OpenRouter video models: 480p by default (the budget
 * choice), higher resolutions labelled with how much more they cost.
 */
export function openRouterResolution(
  values: readonly string[]
): SettingField & { type: "enum" } {
  return {
    type: "enum",
    values,
    default: "480p",
    label: "Resolution",
    labels: Object.fromEntries(
      values.map((value) => [value, RESOLUTION_LABELS[value] ?? value])
    ),
  }
}

export function openRouterAspect(
  values: readonly string[]
): SettingField & { type: "enum" } {
  return {
    type: "enum",
    values: ["auto", ...values],
    default: "16:9",
    label: "Aspect ratio",
    labels: { auto: "Auto (follow the input)" },
    hint: "Auto lets the model follow the start frame; a text-only prompt then uses the model default.",
  }
}

function imagePart(url: string) {
  return { type: "image_url", image_url: { url } } as const
}

/**
 * Plane → OpenRouter video request body.
 *   text:        prompt only
 *   frames:      start (→ first_frame) and optional end (→ last_frame)
 *   references:  image references → input_references
 * Audio and video references are documented for Seedance 2+ but change the
 * price (input video is billed), so this mapper only offers image references.
 */
export function mapOpenRouterVideo(
  plane: GenerationPlane,
  slug: string
): PlatformRequest {
  assertFramesOrReferences(plane)
  const start = first(plane, "start")
  const end = first(plane, "end")
  const refs = urls(plane, "reference")
  const text = promptText(plane)
  if (!text && !start && !refs.length)
    throw new Error("Enter a prompt or add a start frame.")
  const frame_images = start
    ? [
        { ...imagePart(start), frame_type: "first_frame" },
        ...(end ? [{ ...imagePart(end), frame_type: "last_frame" }] : []),
      ]
    : undefined
  return {
    path: openRouterPath(slug),
    body: compact({
      model: slug,
      prompt: text,
      duration: int(plane.settings.duration),
      resolution: plane.settings.resolution,
      aspect_ratio: unlessAuto(plane.settings.aspectRatio),
      generate_audio:
        typeof plane.settings.generateAudio === "boolean"
          ? plane.settings.generateAudio
          : undefined,
      frame_images,
      input_references: refs.length ? refs.map(imagePart) : undefined,
    }),
  }
}
