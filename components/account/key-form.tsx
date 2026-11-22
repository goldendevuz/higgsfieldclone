"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, KeyRound, Loader2, Trash2 } from "lucide-react"

import { deleteKeyAction, saveKeyAction } from "@/app/actions/keys"
import { useToast } from "@/components/providers/app-providers"
import type { ModelPlatform } from "@/generation/catalog/types"
import type { KeyStatus } from "@/lib/byok/keys-types"
import { cn } from "@/lib/utils"

const PROVIDERS: {
  id: ModelPlatform
  name: string
  placeholder: string
  help: string
  link: { href: string; label: string }
  note: string
}[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    placeholder: "sk-or-v1-…",
    help: "Runs the OpenRouter models: Seedance, Veo, Wan, Grok, Runway and more.",
    link: {
      href: "https://openrouter.ai/settings/keys",
      label: "Create a key at openrouter.ai",
    },
    note: "We check the key with a harmless call to OpenRouter before saving it.",
  },
  {
    id: "higgsfield",
    name: "Higgsfield",
    placeholder: "key_id:key_secret",
    help: "Runs the Higgsfield models: Kling, Soul, Seedance, Cinema Studio and more.",
    link: {
      href: "https://console.higgsfield.ai",
      label: "Create a key at console.higgsfield.ai",
    },
    note: "Higgsfield documents no read-only account call, so we only check the format here. A wrong key fails on the first generation.",
  },
]

/** One card per provider: status (last four only), save / replace, delete. */
export function KeyForm({
  enabled,
  initial,
  highlight,
}: {
  enabled: boolean
  initial: KeyStatus[]
  highlight?: ModelPlatform
}) {
  const [statuses, setStatuses] = useState(initial)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          enabled={enabled}
          status={statuses.find((item) => item.provider === provider.id)}
          highlighted={highlight === provider.id}
          onChange={setStatuses}
        />
      ))}
    </div>
  )
}

function ProviderCard({
  provider,
  enabled,
  status,
  highlighted,
  onChange,
}: {
  provider: (typeof PROVIDERS)[number]
  enabled: boolean
  status?: KeyStatus
  highlighted: boolean
  onChange: (statuses: KeyStatus[]) => void
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const toast = useToast()
  const router = useRouter()
  const id = `key-${provider.id}`

  const save = () =>
    startTransition(async () => {
      setError(null)
      const result = await saveKeyAction(provider.id, value)
      if (!result.ok) {
        setError(result.error)
        return
      }
      // The key is gone from the form the moment it is saved.
      setValue("")
      onChange(result.data)
      toast.success(`${provider.name} key saved`)
      // Layout data (which models are active) depends on the keys.
      router.refresh()
    })

  const remove = () =>
    startTransition(async () => {
      setError(null)
      const result = await deleteKeyAction(provider.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setConfirmDelete(false)
      onChange(result.data)
      toast.info(`${provider.name} key removed`)
      router.refresh()
    })

  return (
    <section
      aria-labelledby={`${id}-title`}
      id={provider.id}
      className={cn(
        "flex flex-col gap-3 rounded-2xl bg-surface p-5",
        highlighted && "ring-2 ring-lime/60"
      )}
    >
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden />
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {provider.name}
        </h2>
        <span
          data-testid={`${provider.id}-status`}
          className={cn(
            "ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
            status
              ? "bg-lime/15 text-lime"
              : "bg-white/10 text-muted-foreground"
          )}
        >
          {status ? (
            <>
              <Check className="size-3" aria-hidden /> Connected ····
              {status.last4}
            </>
          ) : (
            "Not connected"
          )}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{provider.help}</p>
      {status ? (
        <p className="text-xs text-muted-foreground">
          {status.verified
            ? "Checked with the provider when saved."
            : "Format checked only."}{" "}
          Models of {provider.name} run on your key and cost no credits.
        </p>
      ) : null}
      <label htmlFor={id} className="text-xs font-medium">
        {status ? "Replace key" : "Your key"}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={!enabled || pending}
        onChange={(event) => setValue(event.target.value)}
        placeholder={provider.placeholder}
        className="h-10 rounded-[10px] bg-page px-3 font-mono text-sm ring-1 ring-white/10 outline-none focus:ring-white/30 disabled:opacity-50"
      />
      {error ? (
        <p role="alert" className="text-xs text-[#ff8fb3]">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {provider.note}{" "}
        <a
          href={provider.link.href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          {provider.link.label}
        </a>
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!enabled || pending || !value.trim()}
          className="btn-keycap flex h-10 items-center gap-2 rounded-[10px] px-4 text-sm font-semibold disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {status ? "Replace key" : "Save key"}
        </button>
        {status ? (
          confirmDelete ? (
            <>
              <button
                type="button"
                onClick={remove}
                disabled={pending}
                className="flex h-10 items-center gap-2 rounded-[10px] bg-[#ff005b]/20 px-4 text-sm font-medium text-[#ff8fb3] hover:bg-[#ff005b]/30"
              >
                Yes, delete the key
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="h-10 rounded-[10px] px-3 text-sm text-muted-foreground hover:bg-white/5"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
              className="flex h-10 items-center gap-2 rounded-[10px] bg-white/5 px-4 text-sm font-medium hover:bg-white/10"
            >
              <Trash2 className="size-4" aria-hidden /> Delete
            </button>
          )
        ) : null}
      </div>
      {status ? (
        <p className="text-xs text-muted-foreground">
          Deleting a key doesn&apos;t cancel runs already started on it; those
          can no longer be fetched and end as failed.
        </p>
      ) : null}
    </section>
  )
}
