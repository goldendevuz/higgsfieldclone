import { requireUser } from "@/lib/auth/session"
import { errorResponse, json } from "@/lib/http"
import {
  describeExpandError,
  expandConfigured,
  expandPrompt,
} from "@/lib/openrouter/expand"
import { expandInputSchema } from "@/lib/prompt-expand"
import { enforceRateLimit, LIMITS } from "@/lib/rate-limit"

/**
 * POST /api/prompt/expand — turn a one-line idea into a detailed scene prompt.
 * Signed-in users only, rate limited per user, and free of credits (the
 * provider cost is a fraction of a cent and is logged).
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser()
    if (!expandConfigured())
      return json(
        { error: "Prompt expansion isn't available.", code: "UNAVAILABLE" },
        503
      )
    const body: unknown = await request.json().catch(() => null)
    const input = expandInputSchema.parse(body)
    await enforceRateLimit(
      `expand:${user.id}`,
      LIMITS.expandPerUser.limit,
      LIMITS.expandPerUser.window,
      "You've expanded a lot of prompts. Try again later."
    )
    try {
      const { prompt, costUsd } = await expandPrompt(input)
      if (costUsd !== undefined)
        console.info(
          `[expand] user ${user.id} ${input.kind} cost $${costUsd.toFixed(6)}`
        )
      return json({ prompt })
    } catch (caught) {
      const { message, operatorAlert } = describeExpandError(caught)
      if (operatorAlert) console.error(`[expand] ${operatorAlert}`)
      else
        console.warn(
          "[expand] failed",
          caught instanceof Error ? caught.name : "error"
        )
      return json({ error: message, code: "EXPAND_FAILED" }, 502)
    }
  } catch (caught) {
    return errorResponse(caught)
  }
}
