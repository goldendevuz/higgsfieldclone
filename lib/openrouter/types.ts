/**
 * OpenRouter video job statuses, per
 * https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request
 * (`VideoGenerationResponse.status`). `failed`, `cancelled` and `expired` are
 * terminal like `completed`; a failed job carries `error` and is not billed.
 */
export type OpenRouterStatus =
  "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired"

/** Our own status vocabulary (shared with Higgsfield), see `mapJobStatus`. */
export type MappedStatus =
  "queued" | "in_progress" | "completed" | "failed" | "canceled" | "unknown"

/** 202 response of POST /videos. */
export type SubmittedJob = {
  id: string
  generationId?: string
  pollingUrl: string
  status: string
}
