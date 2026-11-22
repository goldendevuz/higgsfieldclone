import "server-only"

import { OpenRouterError } from "./client"

/**
 * OpenRouter errors → plain messages for the prompt dock. Status codes per
 * https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request
 * (400, 401, 402, 403, 404, 413, 429, 5xx). Operator problems (bad key, empty
 * balance) are logged loudly but shown generically.
 */
export function describeOpenRouterError(error: unknown): {
  message: string
  operatorAlert?: string
} {
  if (!(error instanceof OpenRouterError))
    return {
      message: "Something went wrong starting this generation. Try again.",
    }
  const detail = error.message
  const unavailable =
    "Generation is temporarily unavailable. Please try again soon."
  switch (error.status) {
    case 400:
      return { message: `The model rejected this request: ${trim(detail)}` }
    case 401:
      return {
        message: unavailable,
        operatorAlert: "OpenRouter rejected OPENROUTER_API_KEY (401).",
      }
    case 402:
      return {
        message: unavailable,
        operatorAlert:
          "OpenRouter account is out of credits (402). Add credits at https://openrouter.ai/credits.",
      }
    case 403:
      return {
        message: unavailable,
        operatorAlert: `OpenRouter refused this key (403): ${trim(detail)}`,
      }
    case 404:
      return {
        message: "This model isn't available right now. Pick another model.",
      }
    case 413:
      return {
        message: "Your reference images are too large. Use smaller images.",
      }
    case 429:
      return { message: "The studio is busy. Try again in a moment." }
    default:
      return {
        message: "The model service had a problem. Try again in a moment.",
      }
  }
}

function trim(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > 180 ? `${clean.slice(0, 177)}…` : clean
}
