// More text / image-to-video models served by OpenRouter's video API.
// Every value below is copied from the live model list
//   https://openrouter.ai/api/v1/videos/models   (resolutions, aspect ratios,
//   durations, frame support, generate_audio, pricing_skus; checked in as
//   lib/openrouter/models.generated.json and compared with this file by
//   tests/openrouter-models.test.ts)
// and the request schema
//   https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request
//   https://openrouter.ai/docs/guides/overview/multimodal/video-generation
// One endpoint (POST /api/v1/videos) serves every model; see ../openrouter.ts.
//
// Wired: text and first (+ last) frame → `frame_images`, `duration`,
// `resolution`, `aspect_ratio`, `generate_audio`. Image references
// (`input_references`) are offered for the Seedance family only (as for the
// two Seedance entries in seedance-openrouter.ts); the list says nothing about
// reference support for the others.
// Not wired (see docs/model-catalog.md): HeyGen (avatar / talking-head),
// FLUX Video Edit / Upscale, Runway Aleph 2 (edit), and `previous_job_id`
// continuation. Resolution defaults to the cheapest one the list prices.
import {
  mapOpenRouterVideo,
  openRouterAspect,
  openRouterResolution,
} from "../openrouter"
import type { MediaMode, ModelBadge, ModelEntry } from "../types"

const GUIDE =
  "https://openrouter.ai/docs/guides/overview/multimodal/video-generation"
const SUBMIT =
  "https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request"
const MODELS = "https://openrouter.ai/api/v1/videos/models"

type Spec = {
  id: string
  slug: string
  label: string
  family: string
  provider: string
  icon?: string
  description: string
  bestFor: string
  badges?: ModelBadge[]
  category: string
  order: number
  /** As listed, in the list's spelling ("4K", "2K"). */
  resolutions: string[]
  /** Resolution preselected: the cheapest one the model's SKUs price. */
  defaultResolution: string
  /** Offer no resolution setting: the model has exactly one. */
  fixedResolution?: boolean
  /** Listed aspect ratios; fewer than two means no aspect setting. */
  aspects: string[]
  durations: number[]
  /** Offer a "Generate audio" toggle (the model lists generate_audio: true). */
  audioToggle?: boolean
  frames: "first" | "first-last"
  /** Start frame is required (image-to-video only). */
  requireStart?: boolean
  /** Image references (Seedance family). */
  references?: number
}

const span = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

const SPECS: Spec[] = [
  {
    id: "seedance-2.5-flash-openrouter",
    slug: "bytedance/seedance-2.5-flash",
    label: "Seedance 2.5 Flash (OpenRouter)",
    family: "Seedance",
    provider: "ByteDance",
    icon: "seedance",
    description:
      "Seedance 2.5 at a lower price: 4–30 s from text, frames or image references, with sound.",
    bestFor: "Cheaper Seedance 2.5 clips",
    badges: ["FAST", "AUDIO"],
    category: "FAST",
    order: 105,
    resolutions: ["480p", "720p"],
    defaultResolution: "480p",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    durations: span(4, 30),
    audioToggle: true,
    frames: "first-last",
    references: 9,
  },
  {
    id: "seedance-2.0-openrouter",
    slug: "bytedance/seedance-2.0",
    label: "Seedance 2.0 (OpenRouter)",
    family: "Seedance",
    provider: "ByteDance",
    icon: "seedance",
    description:
      "Seedance 2.0 with sound, 4–15 s from text, frames or image references, up to 4K.",
    bestFor: "Cinematic clips with audio",
    badges: ["AUDIO", "4K"],
    category: "GENERAL",
    order: 106,
    resolutions: ["480p", "720p", "1080p", "4K"],
    defaultResolution: "480p",
    aspects: ["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"],
    durations: span(4, 15),
    audioToggle: true,
    frames: "first-last",
    references: 9,
  },
  {
    id: "seedance-2.0-fast-openrouter",
    slug: "bytedance/seedance-2.0-fast",
    label: "Seedance 2.0 Fast (OpenRouter)",
    family: "Seedance",
    provider: "ByteDance",
    icon: "seedance",
    description:
      "The faster, cheaper Seedance 2.0: 4–15 s at 480p or 720p from text, frames or image references.",
    bestFor: "Quick drafts with sound",
    badges: ["FAST", "AUDIO"],
    category: "FAST",
    order: 107,
    resolutions: ["480p", "720p"],
    defaultResolution: "480p",
    aspects: ["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"],
    durations: span(4, 15),
    audioToggle: true,
    frames: "first-last",
    references: 9,
  },
  {
    id: "veo-3.1-openrouter",
    slug: "google/veo-3.1",
    label: "Veo 3.1 (OpenRouter)",
    family: "Veo",
    provider: "Google",
    icon: "video",
    description:
      "Google's flagship video model: 4, 6 or 8 s with native synchronized audio, from text or first/last frames.",
    bestFor: "Premium realism with sound",
    badges: ["AUDIO", "4K"],
    category: "CINEMATIC",
    order: 120,
    resolutions: ["720p", "1080p", "4K"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16"],
    durations: [4, 6, 8],
    audioToggle: true,
    frames: "first-last",
  },
  {
    id: "veo-3.1-fast-openrouter",
    slug: "google/veo-3.1-fast",
    label: "Veo 3.1 Fast (OpenRouter)",
    family: "Veo",
    provider: "Google",
    icon: "video",
    description:
      "Veo 3.1 for less: 4, 6 or 8 s with audio, from text or first/last frames.",
    bestFor: "Faster, cheaper Veo",
    badges: ["FAST", "AUDIO"],
    category: "FAST",
    order: 121,
    resolutions: ["720p", "1080p", "4K"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16"],
    durations: [4, 6, 8],
    audioToggle: true,
    frames: "first-last",
  },
  {
    id: "veo-3.1-lite-openrouter",
    slug: "google/veo-3.1-lite",
    label: "Veo 3.1 Lite (OpenRouter)",
    family: "Veo",
    provider: "Google",
    icon: "video",
    description:
      "Google's most cost-effective video model: 720p or 1080p, 4, 6 or 8 s, with audio.",
    bestFor: "High-volume Veo drafts",
    badges: ["FAST", "AUDIO"],
    category: "FAST",
    order: 122,
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16"],
    durations: [4, 6, 8],
    audioToggle: true,
    frames: "first-last",
  },
  {
    id: "gemini-omni-1.2-flash-openrouter",
    slug: "google/gemini-omni-1.2-flash",
    label: "Gemini Omni 1.2 Flash (OpenRouter)",
    family: "Gemini Omni",
    provider: "Google",
    icon: "video",
    description:
      "Google's multimodal video model: 3–15 s from text or first/last frames, always with sound. Starts at 360p.",
    bestFor: "Cheap clips with native audio",
    badges: ["AUDIO"],
    category: "FAST",
    order: 123,
    resolutions: ["360p", "720p", "1080p", "4K"],
    defaultResolution: "360p",
    aspects: ["16:9", "9:16"],
    durations: span(3, 15),
    frames: "first-last",
  },
  {
    id: "gemini-omni-1.1-flash-openrouter",
    slug: "google/gemini-omni-1.1-flash",
    label: "Gemini Omni 1.1 Flash (OpenRouter)",
    family: "Gemini Omni",
    provider: "Google",
    icon: "video",
    description:
      "The earlier Gemini Omni: 3–10 s from text or first/last frames, always with sound. Starts at 360p.",
    bestFor: "Cheap clips with native audio",
    badges: ["AUDIO"],
    category: "FAST",
    order: 124,
    resolutions: ["360p", "720p", "1080p", "4K"],
    defaultResolution: "360p",
    aspects: ["16:9", "9:16"],
    durations: span(3, 10),
    frames: "first-last",
  },
  {
    id: "grok-imagine-video-1.5-openrouter",
    slug: "x-ai/grok-imagine-video-1.5",
    label: "Grok Imagine Video 1.5 (OpenRouter)",
    family: "Grok Imagine",
    provider: "xAI",
    icon: "grok",
    description:
      "Grok Imagine Video 1.5: 1–15 s from text or a start frame, with sound, up to 1080p.",
    bestFor: "Fast, stylised clips",
    badges: ["AUDIO"],
    category: "GENERAL",
    order: 130,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "480p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2"],
    durations: span(1, 15),
    audioToggle: true,
    frames: "first",
  },
  {
    id: "grok-imagine-video-1.5-lite-openrouter",
    slug: "x-ai/grok-imagine-video-1.5-lite",
    label: "Grok Imagine Video 1.5 Lite (OpenRouter)",
    family: "Grok Imagine",
    provider: "xAI",
    icon: "grok",
    description:
      "The faster, lower-cost Grok Imagine 1.5: 1–15 s from text or a start frame, with sound.",
    bestFor: "Cheapest Grok clips",
    badges: ["FAST", "AUDIO"],
    category: "FAST",
    order: 131,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "480p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2"],
    durations: span(1, 15),
    audioToggle: true,
    frames: "first",
  },
  {
    id: "grok-imagine-video-openrouter",
    slug: "x-ai/grok-imagine-video",
    label: "Grok Imagine Video (OpenRouter)",
    family: "Grok Imagine",
    provider: "xAI",
    icon: "grok",
    description:
      "The original Grok Imagine Video: 1–15 s at 480p or 720p from text or a start frame.",
    bestFor: "Quick Grok clips",
    category: "GENERAL",
    order: 132,
    resolutions: ["480p", "720p"],
    defaultResolution: "480p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
    durations: span(1, 15),
    frames: "first",
  },
  {
    id: "wan-3-openrouter",
    slug: "alibaba/wan-3.0",
    label: "Wan 3.0 (OpenRouter)",
    family: "Wan",
    provider: "Alibaba",
    icon: "wan",
    description:
      "Wan 3.0: 2–30 s from text or first/last frames with sound, 480p to 1080p.",
    bestFor: "Long, affordable clips",
    badges: ["AUDIO"],
    category: "GENERAL",
    order: 140,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "480p",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    durations: span(2, 30),
    audioToggle: true,
    frames: "first-last",
  },
  {
    id: "wan-3-prime-openrouter",
    slug: "alibaba/wan-3.0-prime",
    label: "Wan 3.0 Prime (OpenRouter)",
    family: "Wan",
    provider: "Alibaba",
    icon: "wan",
    description:
      "Wan 3.0 Prime: the higher-quality tier, 2–30 s from text or first/last frames with sound.",
    bestFor: "Better quality Wan clips",
    badges: ["AUDIO", "PRO"],
    category: "GENERAL",
    order: 141,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "480p",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    durations: span(2, 30),
    audioToggle: true,
    frames: "first-last",
  },
  {
    id: "happy-horse-1-openrouter",
    slug: "alibaba/happyhorse-1.0",
    label: "HappyHorse 1.0 (OpenRouter)",
    family: "Happy Horse",
    provider: "Alibaba",
    icon: "happy-horse",
    description:
      "HappyHorse 1.0: 3–15 s at 720p or 1080p from text or a start frame.",
    bestFor: "Short clips from a still",
    category: "GENERAL",
    order: 150,
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"],
    durations: span(3, 15),
    frames: "first",
  },
  {
    id: "happy-horse-1.1-openrouter",
    slug: "alibaba/happyhorse-1.1",
    label: "HappyHorse 1.1 (OpenRouter)",
    family: "Happy Horse",
    provider: "Alibaba",
    icon: "happy-horse",
    description:
      "HappyHorse 1.1: 3–15 s at 720p or 1080p from text or a start frame, at a lower 1080p price.",
    bestFor: "Short clips from a still",
    category: "GENERAL",
    order: 151,
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"],
    durations: span(3, 15),
    frames: "first",
  },
  {
    id: "hailuo-3-openrouter",
    slug: "minimax/hailuo-3",
    label: "MiniMax H3 (OpenRouter)",
    family: "MiniMax",
    provider: "MiniMax",
    icon: "minimax",
    description:
      "MiniMax H3: 5–15 s at 2K from text or first/last frames, with sound.",
    bestFor: "Sharp 2K clips",
    badges: ["AUDIO"],
    category: "GENERAL",
    order: 160,
    resolutions: ["2K"],
    defaultResolution: "2K",
    fixedResolution: true,
    aspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durations: span(5, 15),
    audioToggle: true,
    frames: "first-last",
  },
  {
    id: "hailuo-3-max-openrouter",
    slug: "minimax/hailuo-3-max",
    label: "MiniMax H3 Max (OpenRouter)",
    family: "MiniMax",
    provider: "MiniMax",
    icon: "minimax",
    description:
      "MiniMax H3 Max: faster text and image-to-video, 5–15 s at 480p or 768p, no sound.",
    bestFor: "Fast, cheap MiniMax clips",
    badges: ["FAST"],
    category: "FAST",
    order: 161,
    resolutions: ["480p", "768p"],
    defaultResolution: "480p",
    aspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durations: span(5, 15),
    frames: "first-last",
  },
  {
    id: "hailuo-2.3-openrouter",
    slug: "minimax/hailuo-2.3",
    label: "Hailuo 2.3 (OpenRouter)",
    family: "MiniMax",
    provider: "MiniMax",
    icon: "minimax",
    description:
      "Hailuo 2.3 at 1080p 16:9: 6 or 10 s from text or a start frame. No sound.",
    bestFor: "Natural physics at 1080p",
    category: "GENERAL",
    order: 162,
    resolutions: ["1080p"],
    defaultResolution: "1080p",
    fixedResolution: true,
    aspects: ["16:9"],
    durations: [6, 10],
    frames: "first",
  },
  {
    id: "runway-gen-4.5-openrouter",
    slug: "runway/gen-4.5",
    label: "Runway Gen-4.5 (OpenRouter)",
    family: "Runway",
    provider: "Runway",
    icon: "video",
    description:
      "Runway Gen-4.5: cinematic 720p clips of 2–10 s from text or a start frame. No sound.",
    bestFor: "Cinematic scenes",
    category: "CINEMATIC",
    order: 170,
    resolutions: ["720p"],
    defaultResolution: "720p",
    fixedResolution: true,
    aspects: ["16:9", "9:16"],
    durations: span(2, 10),
    frames: "first",
  },
  {
    id: "flux-3-video-openrouter",
    slug: "black-forest-labs/flux-3-video",
    label: "FLUX.3 Video (OpenRouter)",
    family: "Flux",
    provider: "Black Forest Labs",
    icon: "flux",
    description:
      "FLUX.3 Video: 5–20 s from text or first/last keyframes with sound, 720p up to 4K.",
    bestFor: "Controlled shots with keyframes",
    badges: ["AUDIO", "4K"],
    category: "CINEMATIC",
    order: 180,
    resolutions: ["720p", "1080p", "2K", "4K"],
    defaultResolution: "720p",
    aspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "2:1", "9:21"],
    durations: span(5, 20),
    audioToggle: true,
    frames: "first-last",
  },
  {
    id: "mischief-1-openrouter",
    slug: "tbc/mischief-1",
    label: "Mischief 1 (OpenRouter)",
    family: "Mischief",
    provider: "TBC",
    icon: "video",
    description:
      "TBC's neuron-derived image-to-video model: 3 or 5 s at 480p or 720p from a start frame. No sound.",
    bestFor: "Very cheap image animation",
    badges: ["FAST"],
    category: "FAST",
    order: 190,
    resolutions: ["480p", "720p"],
    defaultResolution: "480p",
    aspects: ["16:9"],
    durations: [3, 5],
    frames: "first",
    requireStart: true,
  },
]

function build(spec: Spec): ModelEntry {
  const contiguous = spec.durations.every(
    (value, index) => index === 0 || value === spec.durations[index - 1]! + 1
  )
  const first = spec.durations[0]!
  const last = spec.durations[spec.durations.length - 1]!
  // 4 s is the budget default wherever the model allows it.
  const defaultDuration = spec.durations.includes(4) ? 4 : first
  // Frames and references are exclusive modes only where references exist.
  const modes: MediaMode[] = spec.references
    ? [
        {
          id: "frames",
          label: "Frames",
          roles:
            spec.frames === "first-last" ? { start: 1, end: 1 } : { start: 1 },
        },
        {
          id: "references",
          label: "References",
          roles: { reference: spec.references },
          requireAny: true,
        },
      ]
    : []
  const roles: ModelEntry["roles"] = {
    start: 1,
    ...(spec.frames === "first-last" ? { end: 1 } : {}),
    ...(spec.references ? { reference: spec.references } : {}),
  }
  const settings: ModelEntry["settings"] = {
    ...(spec.aspects.length > 1
      ? { aspectRatio: openRouterAspect(spec.aspects) }
      : {}),
    duration: contiguous
      ? {
          type: "range",
          min: first,
          max: last,
          default: defaultDuration,
          unit: "s",
          label: "Duration",
          hint: "Cost grows with every second.",
        }
      : {
          type: "enum",
          values: spec.durations.map(String),
          default: String(defaultDuration),
          label: "Duration",
          labels: Object.fromEntries(
            spec.durations.map((value) => [String(value), `${value}s`])
          ),
          hint: "Cost grows with every second.",
        },
    ...(spec.fixedResolution
      ? {}
      : {
          resolution: openRouterResolution(
            spec.resolutions,
            spec.defaultResolution
          ),
        }),
    ...(spec.audioToggle
      ? {
          generateAudio: {
            type: "boolean",
            default: true,
            label: "Generate audio",
            hint: "Native soundtrack and effects.",
          },
        }
      : {}),
  }
  return {
    id: spec.id,
    surface: "video",
    platform: "openrouter",
    label: spec.label,
    family: spec.family,
    provider: spec.provider,
    ...(spec.icon ? { icon: spec.icon } : {}),
    description: spec.description,
    bestFor: spec.bestFor,
    ...(spec.badges ? { badges: spec.badges } : {}),
    category: spec.category,
    roles,
    ...(spec.requireStart ? { requiredRoles: ["start" as const] } : {}),
    ...(spec.references ? { maxTotalMedia: spec.references } : {}),
    ...(modes.length ? { mediaModes: modes } : {}),
    settings,
    order: spec.order,
    docs: [SUBMIT, GUIDE, MODELS],
    toPlatform: (plane) =>
      mapOpenRouterVideo(
        plane,
        spec.slug,
        spec.fixedResolution ? { resolution: spec.defaultResolution } : {}
      ),
  }
}

/** The specs, for tests that compare them with the checked-in model list. */
export const OPENROUTER_VIDEO_SPECS: readonly Spec[] = SPECS

const models: ModelEntry[] = SPECS.map(build)
export default models
