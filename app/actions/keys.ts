"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { runAction } from "@/lib/action-result"
import type { ActionResult } from "@/lib/action-types"
import { requireUser } from "@/lib/auth/session"
import { deleteUserKey, listUserKeys, saveUserKey } from "@/lib/byok/keys"
import type { KeyStatus } from "@/lib/byok/keys-types"

const providerSchema = z.enum(["openrouter", "higgsfield"], {
  message: "Unknown provider.",
})
const keySchema = z.string().max(400, "That key is too long.")

/**
 * Store (or replace) the signed-in user's own provider key. The reply is the
 * status of the user's keys: last four characters only, never the key.
 */
export async function saveKeyAction(
  provider: string,
  key: string
): Promise<ActionResult<KeyStatus[]>> {
  return runAction(async () => {
    const user = await requireUser()
    await saveUserKey(
      user.objectId,
      providerSchema.parse(provider),
      keySchema.parse(key)
    )
    revalidatePath("/account/keys")
    return listUserKeys(user.objectId)
  })
}

export async function deleteKeyAction(
  provider: string
): Promise<ActionResult<KeyStatus[]>> {
  return runAction(async () => {
    const user = await requireUser()
    await deleteUserKey(user.objectId, providerSchema.parse(provider))
    revalidatePath("/account/keys")
    return listUserKeys(user.objectId)
  })
}
