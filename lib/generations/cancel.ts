import "server-only"

import type { ObjectId } from "mongodb"

import { NotFoundError, UserFacingError } from "@/lib/errors"
import { collections, platformOfDoc } from "@/lib/db/collections"
import { UserKeyMissingError } from "@/lib/byok/keys"
import { PlatformError } from "@/lib/higgsfield/client"

import { higgsfieldFor, userKeyActionError } from "./credentials"
import { finalizeGeneration } from "./finalize"

/**
 * Cancel really cancels on the platform (POST /requests/{id}/cancel): 202 while
 * queued, 400 once processing started. The canceled status then flows through
 * finalizeGeneration, which refunds exactly once.
 */
export async function cancelGeneration(
  userId: ObjectId,
  generationId: ObjectId
): Promise<void> {
  const { generations } = await collections()
  const gen = await generations.findOne({ _id: generationId, userId })
  if (!gen) throw new NotFoundError("Generation not found.")
  // OpenRouter documents no cancel endpoint, so we don't pretend: the job runs
  // to its end (a failed one isn't billed; the run timeout still refunds).
  if (platformOfDoc(gen) === "openrouter")
    throw new UserFacingError(
      "OpenRouter generations can't be canceled once started. It will finish or fail on its own.",
      "NOT_CANCELABLE"
    )
  if (gen.status === "pending_submit")
    throw new UserFacingError(
      "Still starting — try cancelling again in a few seconds.",
      "NOT_YET"
    )
  if (gen.status !== "queued")
    throw new UserFacingError(
      gen.status === "in_progress"
        ? "This generation already started, so it can't be canceled."
        : "This generation already finished.",
      "NOT_CANCELABLE"
    )
  try {
    await (await higgsfieldFor(gen)).cancel(gen.hfRequestId!)
  } catch (caught) {
    if (caught instanceof UserKeyMissingError) throw userKeyActionError(caught)
    if (caught instanceof PlatformError && caught.status === 400) {
      await generations.updateOne(
        { _id: gen._id, status: "queued" },
        { $set: { status: "in_progress", updatedAt: new Date() } }
      )
      throw new UserFacingError(
        "This generation already started, so it can't be canceled.",
        "NOT_CANCELABLE"
      )
    }
    throw caught
  }
  await finalizeGeneration(gen._id)
}
