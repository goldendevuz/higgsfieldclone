import "server-only"

import { after } from "next/server"
import { ObjectId } from "mongodb"

import type { ModelPlatform } from "@/generation/catalog/types"
import { isDuplicateKey } from "@/lib/billing/ledger"
import { collections, platformOfDoc } from "@/lib/db/collections"

import { finalizeGeneration } from "./finalize"

/**
 * What a provider's completion webhook does once its URL token has been
 * verified (each provider's route checks its own token and envelope shape).
 * The payload itself is never trusted beyond "this job reached a terminal
 * state": finalizeGeneration re-fetches the status from the provider.
 */
export async function acceptProviderWebhook(input: {
  platform: ModelPlatform
  generationId: string
  requestId: string
  status: string
}): Promise<{ ok: true; ignored?: string }> {
  const { platform, requestId, status } = input
  const { generations, hfWebhookEvents } = await collections()
  const generationId = new ObjectId(input.generationId)
  const gid = input.generationId
  let duplicate = false
  try {
    await hfWebhookEvents.insertOne({
      _id: new ObjectId(),
      requestId,
      status,
      generationId,
      receivedAt: new Date(),
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    duplicate = true
  }

  const gen = await generations.findOne({ _id: generationId })
  if (!gen) return { ok: true, ignored: "unknown generation" }
  // A URL token for one provider must never drive the other's generations.
  if (platformOfDoc(gen) !== platform)
    return { ok: true, ignored: "platform mismatch" }
  if (gen.hfRequestId && gen.hfRequestId !== requestId)
    return { ok: true, ignored: "request mismatch" }

  if (!gen.hfRequestId) {
    // The submit response never arrived (ambiguous); adopt the request now.
    await generations.updateOne(
      { _id: gen._id, hfRequestId: { $exists: false } },
      { $set: { hfRequestId: requestId, updatedAt: new Date() } }
    )
  }
  if (
    status === "completed" &&
    gen.status === "failed" &&
    (gen.errorKind === "submit" || gen.errorKind === "timeout")
  ) {
    // Late success for a run we already refunded: deliver it anyway.
    console.warn(
      `[webhook] late delivery for ${gid}; delivering without re-charging`
    )
    await generations.updateOne(
      { _id: gen._id, status: "failed" },
      {
        $set: {
          status: "in_progress",
          hfRequestId: requestId,
          updatedAt: new Date(),
        },
        $unset: { error: "", errorKind: "", finishedAt: "" },
      }
    )
  }

  if (!duplicate || gen.status !== "completed")
    after(async () => {
      try {
        await finalizeGeneration(gen._id)
      } catch (error) {
        // The reconciler retries anything left in flight.
        console.error(`[webhook] finalize failed for ${gid}`, error)
      }
    })
  return { ok: true }
}
