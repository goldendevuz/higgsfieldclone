// Seedance via OpenRouter — text, first/last frame and image-reference video.
// Same models as the Higgsfield Seedance entries, different provider and
// price list, so they are separate picker entries (ids end in -openrouter).
// Sources:
//   https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request
//   https://openrouter.ai/docs/guides/overview/multimodal/video-generation
//   https://openrouter.ai/api/v1/videos/models  (resolutions, ratios, durations, prices)
// Not offered (docs don't fully specify them, or they change the price):
//   • Edit / Extend (`previous_job_id`): only "models that support continuation"
//     accept it and no page says which, nor how it is billed.
//   • Audio and video references: documented for Seedance 2+, but input video
//     is billed per second and the limits aren't published.
// Reference-image cap (9) is ours: OpenRouter publishes none; 9 is the
// Seedance 2.0 limit on the Higgsfield docs.
import {
  mapOpenRouterVideo,
  openRouterAspect,
  openRouterResolution,
} from "../openrouter"
import type { ModelEntry } from "../types"

const GUIDE =
  "https://openrouter.ai/docs/guides/overview/multimodal/video-generation"
const SUBMIT =
  "https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request"
const MODELS = "https://openrouter.ai/api/v1/videos/models"

const meta = {
  surface: "video",
  platform: "openrouter",
  family: "Seedance",
  provider: "ByteDance",
  icon: "seedance",
  roles: { start: 1, end: 1, reference: 9 },
  maxTotalMedia: 9,
  mediaModes: [
    { id: "frames", label: "Frames", roles: { start: 1, end: 1 } },
    {
      id: "references",
      label: "References",
      roles: { reference: 9 },
      requireAny: true,
    },
  ],
} as const satisfies Partial<ModelEntry>

const generateAudio = {
  type: "boolean",
  default: true,
  label: "Generate audio",
  hint: "Native soundtrack and effects. Does not change the price.",
} as const satisfies ModelEntry["settings"][string]

// Seedance 2.5 -------------------------------------------------------------

export const seedance25OpenRouter: ModelEntry = {
  ...meta,
  id: "seedance-2.5-openrouter",
  label: "Seedance 2.5 (OpenRouter)",
  description:
    "Seedance 2.5 through OpenRouter: 4–30 s from text, first/last frames or image references. Starts at 480p to keep costs low.",
  bestFor: "Final shots after a cheap draft",
  badges: ["AUDIO"],
  category: "GENERAL",
  settings: {
    aspectRatio: openRouterAspect([
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16",
      "21:9",
    ]),
    duration: {
      type: "range",
      min: 4,
      max: 30,
      default: 4,
      unit: "s",
      label: "Duration",
      hint: "Cost grows with every second.",
    },
    resolution: openRouterResolution(["480p", "720p", "1080p"]),
    generateAudio,
  },
  order: 103,
  docs: [SUBMIT, GUIDE, MODELS],
  toPlatform: (plane) => mapOpenRouterVideo(plane, "bytedance/seedance-2.5"),
}

// Seedance 2.0 Mini --------------------------------------------------------

export const seedance20MiniOpenRouter: ModelEntry = {
  ...meta,
  id: "seedance-2.0-mini-openrouter",
  label: "Seedance 2.0 Mini (OpenRouter)",
  description:
    "The cheap draft model: 4–15 s at 480p for a fraction of Seedance 2.5. Try ideas here, then render the keeper on 2.5.",
  bestFor: "Low-cost drafts and prompt tests",
  badges: ["FAST", "AUDIO"],
  category: "FAST",
  settings: {
    aspectRatio: openRouterAspect([
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16",
      "21:9",
      "9:21",
    ]),
    duration: {
      type: "range",
      min: 4,
      max: 15,
      default: 4,
      unit: "s",
      label: "Duration",
      hint: "Cost grows with every second.",
    },
    resolution: openRouterResolution(["480p", "720p"]),
    generateAudio,
  },
  order: 104,
  docs: [SUBMIT, GUIDE, MODELS],
  toPlatform: (plane) =>
    mapOpenRouterVideo(plane, "bytedance/seedance-2.0-mini"),
}

const models = [seedance25OpenRouter, seedance20MiniOpenRouter]
export default models
