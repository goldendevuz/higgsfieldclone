import type { ModelPlatform } from "@/generation/catalog/types"

/** What the browser may know about a stored key (never the key itself). */
export type KeyStatus = {
  provider: ModelPlatform
  last4: string
  /** The provider confirmed the key when it was saved. */
  verified: boolean
  createdAt: number
  lastUsedAt?: number
}
