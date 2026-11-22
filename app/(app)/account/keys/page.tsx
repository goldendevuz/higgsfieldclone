import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { KeyForm } from "@/components/account/key-form"
import { currentUser } from "@/lib/auth/session"
import { byokEnabled, listUserKeys } from "@/lib/byok/keys"

export const metadata: Metadata = { title: "API keys" }

export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect("/login?callbackUrl=/account/keys")
  const { provider } = await searchParams
  const statuses = await listUserKeys(user.objectId)
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-4xl">API keys</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Connect your own OpenRouter or Higgsfield key to run that
          provider&apos;s models on your own account. You pay the provider
          directly, so no credits are used. Keys are stored encrypted, shown
          only as the last four characters, and never sent back to your browser.
        </p>
      </header>
      {byokEnabled() ? null : (
        <p
          role="status"
          className="rounded-2xl border border-pink/30 bg-pink/10 p-4 text-sm text-pink"
        >
          Saving your own keys is not enabled on this server yet (the operator
          has to set BYOK_ENCRYPTION_KEY). You can&apos;t connect a key until
          then.
        </p>
      )}
      <KeyForm
        enabled={byokEnabled()}
        initial={statuses}
        highlight={
          provider === "higgsfield"
            ? "higgsfield"
            : provider === "openrouter"
              ? "openrouter"
              : undefined
        }
      />
    </div>
  )
}
