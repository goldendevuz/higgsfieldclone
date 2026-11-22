import "server-only"

import { env } from "@/lib/env"
import { UserFacingError } from "@/lib/errors"
import {
  buildExpandMessages,
  cleanExpansion,
  type ExpandInput,
} from "@/lib/prompt-expand"

/**
 * One OpenRouter chat completion that turns a one-line idea into a detailed
 * scene prompt. Docs: https://openrouter.ai/docs/api-reference/chat-completion
 * Cheap text model, no retries (a retry could just bill twice), and nothing
 * from the upstream error reaches the user.
 */

export const DEFAULT_EXPAND_MODEL = "anthropic/claude-haiku-5.5"
export const EXPAND_TIMEOUT_MS = 30_000

export function expandConfigured(): boolean {
  return Boolean(env().OPENROUTER_API_KEY)
}

export class ExpandError extends Error {
  constructor(
    readonly status: number | "network" | "empty",
    message: string
  ) {
    super(message)
    this.name = "ExpandError"
  }
}

/** Upstream failure → a message that is safe to show, plus an operator note. */
export function describeExpandError(error: unknown): {
  message: string
  operatorAlert?: string
} {
  if (error instanceof UserFacingError) return { message: error.message }
  if (!(error instanceof ExpandError))
    return { message: "Could not expand the prompt. Try again." }
  const unavailable = "Prompt expansion is temporarily unavailable."
  if (error.status === 401 || error.status === 403)
    return {
      message: unavailable,
      operatorAlert: `OpenRouter refused the key for prompt expansion (${error.status}).`,
    }
  if (error.status === 402)
    return {
      message: unavailable,
      operatorAlert: "OpenRouter account is out of credits (402).",
    }
  if (error.status === 404)
    return {
      message: unavailable,
      operatorAlert:
        "OPENROUTER_EXPAND_MODEL is not available on OpenRouter (404).",
    }
  if (error.status === 429)
    return { message: "The studio is busy. Try again in a moment." }
  if (error.status === "network")
    return { message: "Prompt expansion timed out. Try again." }
  if (error.status === "empty")
    return { message: "The model returned nothing. Try again." }
  return { message: "Prompt expansion failed. Try again in a moment." }
}

type Options = { fetch?: typeof fetch; timeoutMs?: number }

type Expanded = { prompt: string; costUsd?: number }

/** Video prompts must keep their Look line and, with audio on, the Audio line. */
export function isComplete(input: ExpandInput, prompt: string): boolean {
  if (input.kind !== "video") return true
  if (!/^Look:/im.test(prompt)) return false
  return input.hasAudio === false || /^Audio:/im.test(prompt)
}

/**
 * One text call; if the model dropped the Look/Audio line, one more call
 * (a text rewrite is safe to repeat and costs a fraction of a cent).
 */
export async function expandPrompt(
  input: ExpandInput,
  options: Options = {}
): Promise<Expanded> {
  const first = await expandOnce(input, options)
  if (isComplete(input, first.prompt)) return first
  const second = await expandOnce(input, options).catch(() => undefined)
  if (!second) return first
  const costUsd =
    first.costUsd !== undefined || second.costUsd !== undefined
      ? (first.costUsd ?? 0) + (second.costUsd ?? 0)
      : undefined
  const best = isComplete(input, second.prompt) ? second : first
  return { prompt: best.prompt, ...(costUsd !== undefined ? { costUsd } : {}) }
}

async function expandOnce(
  input: ExpandInput,
  options: Options
): Promise<Expanded> {
  const config = env()
  if (!config.OPENROUTER_API_KEY)
    throw new UserFacingError(
      "Prompt expansion isn't available on this deployment.",
      "UNAVAILABLE"
    )
  const base = config.OPENROUTER_API_BASE_URL.replace(/\/$/, "")
  const model = config.OPENROUTER_EXPAND_MODEL ?? DEFAULT_EXPAND_MODEL
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? EXPAND_TIMEOUT_MS
  )
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: buildExpandMessages(input),
        max_tokens: 900,
        temperature: 0.6,
        reasoning: { enabled: false },
      }),
      signal: controller.signal,
      cache: "no-store",
      // The key must not follow a redirect to another origin.
      redirect: "error",
    })
  } catch {
    throw new ExpandError("network", "request failed or timed out")
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new ExpandError(response.status, "upstream error")
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ExpandError("empty", "unreadable response")
  }
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const choices = record(payload).choices
  const content = record(
    record(Array.isArray(choices) ? choices[0] : {}).message
  ).content
  const prompt = typeof content === "string" ? cleanExpansion(content) : ""
  if (!prompt) throw new ExpandError("empty", "no content")
  const cost = record(record(payload).usage).cost
  const costUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? cost
      : undefined
  return { prompt, ...(costUsd !== undefined ? { costUsd } : {}) }
}
