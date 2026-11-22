/**
 * One real OpenRouter video job, from the command line, to check the
 * integration against the live API before using it in the app. It spends real
 * money, so it does nothing without --yes and prints the estimate first.
 *
 *   pnpm smoke:openrouter mini           # dry run: Seedance 2.0 Mini, 4 s, 480p
 *   pnpm smoke:openrouter mini --yes     # sends it (about $0.14)
 *   pnpm smoke:openrouter seedance-2.5 --yes   # Seedance 2.5, 4 s, 480p (about $0.41)
 *
 * It reads OPENROUTER_API_KEY (and OPENROUTER_API_BASE_URL) from .env.local or
 * the environment, creates exactly one job, polls it, downloads the MP4 with
 * the key into .data/smoke/, and compares OpenRouter's `usage.cost` with our
 * estimate. No database, no credits, no webhook. The key is never printed.
 */
import "./load-env"

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const MODELS = {
  mini: "seedance-2.0-mini-openrouter",
  "seedance-2.5": "seedance-2.5-openrouter",
} as const

const choice = process.argv[2] as keyof typeof MODELS | undefined
const confirmed = process.argv.includes("--yes")
if (!choice || !(choice in MODELS)) {
  console.error(
    `Usage: pnpm smoke:openrouter <${Object.keys(MODELS).join("|")}> [--yes]`
  )
  process.exit(2)
}

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error(
    "OPENROUTER_API_KEY is not set (put it in .env.local; never commit it)."
  )
  process.exit(2)
}

const { getModel, parseSettings } = await import("../generation/catalog")
const { toPlatform } = await import("../generation/to-platform")
const { OPENROUTER_PRICING } = await import("../lib/openrouter/pricing")
const { usdForRequest } = await import("../lib/billing/price")
const { createOpenRouterClient } = await import("../lib/openrouter/client")

const model = getModel(MODELS[choice])
const request = toPlatform({
  model: model.id,
  prompt: {
    text: "A paper boat drifting down a rain-soaked street at dusk, slow camera follow.",
  },
  media: {},
  settings: parseSettings(model, {}), // defaults: 4 s, 480p
})
const estimate = usdForRequest(OPENROUTER_PRICING[request.path]!, request, [])
const base =
  process.env.OPENROUTER_API_BASE_URL ?? "https://openrouter.ai/api/v1"

console.log(`Model        ${String(request.body.model)}`)
console.log(
  `Request      ${request.body.duration} s, ${String(request.body.resolution)}, audio ${String(request.body.generate_audio)}`
)
console.log(`Endpoint     ${base}`)
console.log(
  `Estimate     up to $${estimate.toFixed(3)} (our worst-case price basis)`
)
if (!confirmed) {
  console.log("\nDry run. Add --yes to send this one job and spend that money.")
  process.exit(0)
}

const client = createOpenRouterClient({ apiKey, baseUrl: base })
const job = await client.submit(request.body)
console.log(`\nSubmitted    ${job.id} (${job.status})`)

const deadline = Date.now() + 15 * 60_000
let status = await client.status(job.id)
while (
  !["completed", "failed", "canceled"].includes(status.status) &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  status = await client.status(job.id)
  console.log(`Status       ${status.status}`)
}

if (status.status !== "completed") {
  console.error(
    `\nEnded as ${status.status}${status.error ? `: ${status.error}` : ""}. Failed jobs are not billed.`
  )
  process.exit(1)
}

const artifact = status.artifacts[0]
if (!artifact) {
  console.error("Completed, but no output URL was returned.")
  process.exit(1)
}
const response = await fetch(artifact.url, {
  headers: client.mediaHeaders(artifact.url),
})
if (!response.ok) {
  console.error(`Download failed (${response.status}).`)
  process.exit(1)
}
const bytes = Buffer.from(await response.arrayBuffer())
const dir = join(process.cwd(), ".data", "smoke")
mkdirSync(dir, { recursive: true })
const file = join(dir, `${choice}-${Date.now()}.mp4`)
writeFileSync(file, bytes)

console.log(`\nDownloaded   ${file} (${(bytes.length / 1024).toFixed(0)} KB)`)
if (status.costUsd === undefined)
  console.log("Billed       (usage.cost not reported)")
else {
  const verdict =
    status.costUsd > estimate * 1.01
      ? "ABOVE our price basis: fix lib/openrouter/pricing.ts"
      : "within our price basis"
  console.log(
    `Billed       $${status.costUsd.toFixed(4)} vs estimate $${estimate.toFixed(4)}: ${verdict}`
  )
}
