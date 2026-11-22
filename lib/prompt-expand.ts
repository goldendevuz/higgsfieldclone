import { z } from "zod"

/**
 * Prompt expansion, shared by the route, the prompt builder and the tests.
 * No server imports here: the schema and the beat plan are plain functions.
 */

export const EXPAND_MIN = 3
export const EXPAND_MAX = 500
/** Hard cap on the text we hand back to the prompt box. */
export const EXPANDED_MAX_CHARS = 1200

export const expandInputSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(EXPAND_MIN, "Write at least a few words to expand.")
    .max(EXPAND_MAX, `Keep the idea under ${EXPAND_MAX} characters.`),
  kind: z.enum(["video", "image"]),
  durationSec: z.number().int().min(1).max(60).optional(),
  aspectRatio: z
    .string()
    .trim()
    .regex(/^[0-9]{1,2}:[0-9]{1,2}$|^auto$/i, "Unknown aspect ratio.")
    .optional(),
  hasAudio: z.boolean().optional(),
})

export type ExpandInput = z.infer<typeof expandInputSchema>

export type Beat = { index: number; startSec: number; endSec: number }

/** One beat per ~5 s (at least 1, at most 6); the seconds are split evenly. */
export function beatPlan(durationSec: number): Beat[] {
  const total = Math.max(1, Math.round(durationSec))
  const count = Math.min(6, Math.max(1, Math.ceil(total / 5)))
  const beats: Beat[] = []
  let cursor = 0
  for (let index = 1; index <= count; index++) {
    const end = Math.round((total * index) / count)
    beats.push({ index, startSec: cursor, endSec: end })
    cursor = end
  }
  return beats
}

const SYSTEM_VIDEO = `You are a prompt writer for AI video models (Seedance and similar). Turn the user's one-line idea into one detailed, sequenced scene prompt.
Rules:
- Write in English. If the idea contains names, quoted text or non-English words, keep them exactly as given. Keep the user's idea and intent; add detail, do not change the subject.
- Plain text only: no markdown, no asterisks, no preamble, no closing remarks.
- Use exactly this structure, one item per line:
  Opening frame: one sentence describing the first image. Everything that matters later (every main subject, vehicle, creature or place, including the threat or target) must already be visible or clearly implied in this frame, and the framing must suit the aspect ratio (wide aspect ratios: wide, layered composition with foreground, midground and background).
  Then one line per beat, in the given order, formatted "Beat N (A-B s) NAME: what happens. Camera: one continuous camera move for this beat." NAME is a single capitalised word for the beat (for example PILOT, MISSILE, IMPACT).
  Look: one line with lighting, colour palette and visual style.
  Audio: one line with sub-bass, sound effects and score. (Include this line only when audio is on.)
- Story: the beats are one cause-and-effect chain with a clear stake. First beat: who or what is in danger or under pressure, shown through a person, crew, creature or place we can care about (give a human or character face/reaction when it fits the idea). Middle beat(s): the action that follows. Last beat: the consequence, not just the event. Show what the action caused and end on a settled final image (aftermath, reveal, silhouette), never on an explosion or peak action alone.
- Tone: honour the energy words in the idea. "Epic", "dramatic", "intense", "battle", "chase" or "action" mean real conflict, danger and scale: pick the most cinematic high-stakes situation (a battle, chase, escape, collapse) with an opponent or threat that is visible, and never settle for a calm journey, travel or sightseeing scene. When the idea is vague, choose the most dramatic interpretation that fits it. Calm ideas stay calm.
- Keep the action readable for a video model: one main subject and at most two or three secondary moving objects per beat (for example one or two missiles, not a volley or swarm); no crowds of tiny objects; no more than one scene change in the whole clip; keep the same subjects, colours and positions consistent across beats.
- Camera: one simple, physically plausible move per beat (push-in, pull-back, pan, tracking, crane, orbit). Do not combine several moves in one beat.
- Make sound consistent with the look: realistic style keeps sound physically believable, stylised style may be bolder; the Audio line must match the events of the beats in order.
- Never mention brands, logos, watermarks, subtitles or real people. Do not name real celebrities or copyrighted characters.
- Keep the whole answer under 1000 characters, and never drop the Look or Audio line to fit: write shorter beats instead.`

const SYSTEM_IMAGE = `You are a prompt writer for AI image models. Turn the user's one-line idea into one detailed image prompt.
Rules:
- Write in English. If the idea contains names, quoted text or non-English words, keep them exactly as given. Keep the user's idea and intent; add detail, do not change the subject.
- Plain text only: no markdown, no asterisks, no preamble, no closing remarks.
- Use exactly this structure, one item per line:
  Subject: who or what, with specific visual details.
  Setting: place, time of day, atmosphere.
  Composition: framing, lens and camera angle suited to the aspect ratio.
  Look: lighting, colour palette and style.
- Never mention brands, logos, watermarks, text overlays or real people. Do not name real celebrities or copyrighted characters.
- Keep the whole answer under 800 characters.`

/** The two chat messages sent to the text model. */
export function buildExpandMessages(input: ExpandInput): {
  role: "system" | "user"
  content: string
}[] {
  if (input.kind === "image") {
    const lines = [
      `Idea: ${input.prompt}`,
      input.aspectRatio ? `Aspect ratio: ${input.aspectRatio}` : "",
    ].filter(Boolean)
    return [
      { role: "system", content: SYSTEM_IMAGE },
      { role: "user", content: lines.join("\n") },
    ]
  }
  const duration = input.durationSec ?? 5
  const beats = beatPlan(duration)
  const audio = input.hasAudio ?? true
  const lines = [
    `Idea: ${input.prompt}`,
    `Clip length: ${duration} s`,
    input.aspectRatio
      ? `Aspect ratio: ${input.aspectRatio} (compose the framing for it)`
      : "",
    `Beats (${beats.length}): ${beats
      .map((b) => `Beat ${b.index} ${b.startSec}-${b.endSec} s`)
      .join(", ")}`,
    audio
      ? "Audio: on. Include the Audio line."
      : "Audio: off. Do NOT write an Audio line and do not mention sound.",
  ].filter(Boolean)
  return [
    { role: "system", content: SYSTEM_VIDEO },
    { role: "user", content: lines.join("\n") },
  ]
}

/** Strip reasoning tags/markdown the model may add and enforce the length cap. */
export function cleanExpansion(raw: string): string {
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (text.length > EXPANDED_MAX_CHARS) {
    const cut = text.slice(0, EXPANDED_MAX_CHARS)
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "))
    text = (
      lastBreak > EXPANDED_MAX_CHARS * 0.6 ? cut.slice(0, lastBreak + 1) : cut
    ).trim()
  }
  return text
}
