"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ChevronDown, KeyRound } from "lucide-react"

import { useApp } from "@/components/providers/app-providers"
import { findModel } from "@/generation/catalog"
import type {
  GeneratorTab,
  ModelEntry,
  Surface,
} from "@/generation/catalog/types"
import type { InactiveModel } from "@/lib/billing/pricing"
import { cn } from "@/lib/utils"

import { ModelIcon } from "./model-picker"

export const KEYS_PAGE = "/account/keys"

export type InactiveEntry = { model: ModelEntry; item: InactiveModel }

/** Inactive models for one generator surface (and tab), optionally filtered by a search text. */
export function useInactiveModels(
  surface: Surface,
  tab?: GeneratorTab,
  query = ""
): InactiveEntry[] {
  const { pricing } = useApp()
  return useMemo(() => {
    const q = query.trim().toLowerCase()
    const entries: InactiveEntry[] = []
    for (const item of pricing.inactive) {
      const model = findModel(item.id)
      if (!model || model.surface !== surface) continue
      if (tab && (model.tab ?? "create") !== tab) continue
      if (
        q &&
        !model.label.toLowerCase().includes(q) &&
        !model.family.toLowerCase().includes(q)
      )
        continue
      entries.push({ model, item })
    }
    return entries
  }, [pricing.inactive, query, surface, tab])
}

function connectHref(platform: InactiveModel["platform"]): string {
  return `${KEYS_PAGE}?provider=${platform}`
}

function InactiveRow({ model, item }: InactiveEntry) {
  return (
    <li
      data-testid="inactive-model"
      data-model-id={model.id}
      className="flex items-center gap-3 rounded-xl p-2 pr-3 opacity-60"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-hover grayscale">
        <ModelIcon model={model} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {model.label}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          <span className="sr-only">Inactive. </span>
          {item.reason}
        </span>
      </span>
      <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        from ✦{item.from}
      </span>
      <Link
        href={connectHref(item.platform)}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-xs font-medium text-foreground opacity-100 hover:bg-white/5"
      >
        <KeyRound className="size-3.5" aria-hidden /> Connect key
      </Link>
    </li>
  )
}

/**
 * "Inactive — connect your key": models the visitor can't run yet, collapsed
 * by default, greyed and not selectable. Open while a search matches them.
 */
export function InactiveModelsSection({
  entries,
  forceOpen = false,
}: {
  entries: InactiveEntry[]
  forceOpen?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!entries.length) return null
  const expanded = open || forceOpen
  return (
    <section
      className="mt-6 border-t border-white/5 pt-4"
      aria-label="Inactive models"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="inactive-models-list"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        <KeyRound className="size-3" aria-hidden />
        Inactive — connect your key
        <span className="rounded-full bg-white/10 px-1.5 py-px font-mono text-[10px] normal-case">
          {entries.length}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto size-4 transition-transform",
            expanded && "rotate-180"
          )}
          aria-hidden
        />
      </button>
      {expanded ? (
        <ul
          id="inactive-models-list"
          className="mt-2 grid gap-1 sm:grid-cols-1"
        >
          {entries.map((entry) => (
            <InactiveRow key={entry.model.id} {...entry} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** Shown instead of the generator when the visitor has no usable model for this surface. */
export function NoActiveModels({ surface }: { surface: Surface }) {
  const entries = useInactiveModels(surface)
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-2 p-6">
      <h2 className="font-display text-2xl">No {surface} models are active</h2>
      <p className="text-sm text-muted-foreground">
        {entries.length
          ? "Connect your own provider key to start generating. You pay the provider directly, no credits are used."
          : `No ${surface} models are available right now.`}
      </p>
      <InactiveModelsSection entries={entries} forceOpen />
    </div>
  )
}
