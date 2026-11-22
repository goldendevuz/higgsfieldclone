/** Request statuses, per https://docs.higgsfield.ai/docs/concepts/requests */
export type PlatformStatus =
  "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled"

export const PLATFORM_TERMINAL: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "nsfw",
  "canceled",
])

export type QueuedRequest = {
  status: string
  requestId: string
  statusUrl: string
  cancelUrl: string
}

export type PlatformArtifact = {
  kind: "image" | "video" | "audio" | "file"
  url: string
  contentType?: string
  /** Downloading needs the provider's key (OpenRouter content URLs). */
  authorized?: boolean
  /** Key-less copy of the same file, used only if our own copy keeps failing. */
  fallbackUrl?: string
}

export type RequestStatus = {
  status: string
  requestId: string
  artifacts: PlatformArtifact[]
  error?: string
  /** What the provider billed us in USD, when it says (OpenRouter `usage.cost`). */
  costUsd?: number
}

export type UploadTicket = {
  upload_url: string
  public_url: string
  content_type: string
  upload_headers: Record<string, string>
}

export type Estimate = { credits: number; usd: number }
