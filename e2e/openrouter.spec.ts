import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"

import { balance, dismissCookies, signIn, uniqueEmail } from "./helpers"

/**
 * OpenRouter models against the local mock (`pnpm mock:openrouter`, with
 * OPENROUTER_API_KEY=mock-key and OPENROUTER_API_BASE_URL pointing at it).
 * Run with E2E_OPENROUTER=true; skipped otherwise so the Higgsfield-only
 * stack keeps its own green run.
 */
test.skip(
  process.env.E2E_OPENROUTER !== "true",
  "set E2E_OPENROUTER=true with pnpm mock:openrouter running"
)

const MODEL = "seedance-2.0-mini-openrouter"

async function generate(page: Page, prompt: string) {
  await page.goto(`/video?model=${MODEL}`)
  await dismissCookies(page)
  await page
    .getByRole("textbox", { name: /Prompt|Describe/ })
    .first()
    .fill(prompt)
  await page
    .getByRole("button", { name: /^Generate/ })
    .first()
    .click()
}

test("OpenRouter video: debit, generating tile, finished tile, no cancel", async ({
  page,
}) => {
  await signIn(page, uniqueEmail("or-video"), "/video")
  const before = await balance(page)
  await generate(page, "A paper boat drifting down a rain-soaked street")
  await expect.poll(() => balance(page)).toBeLessThan(before)
  const tile = page.getByRole("button", {
    name: /Open generation: A paper boat/,
  })
  await expect(tile).toBeVisible({ timeout: 60_000 })
  // OpenRouter has no cancel endpoint, so the running tile never offered one.
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole("button", { name: /Open generation: A paper boat/ })
  ).toBeVisible()
})

test("OpenRouter failed jobs show the provider's reason and refund once", async ({
  page,
}) => {
  await signIn(page, uniqueEmail("or-fail"), "/video")
  const before = await balance(page)
  await generate(page, "[fail] this one breaks")
  await expect(page.getByText(/Content policy violation/).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect.poll(() => balance(page)).toBe(before)
})

test("a queued OpenRouter run offers no Cancel", async ({ page }) => {
  await signIn(page, uniqueEmail("or-slow"), "/video")
  await generate(page, "[slow] never cancelable")
  const tile = page.getByRole("status").filter({ hasText: /Queued|Starting/ })
  await expect(tile).toBeVisible()
  await tile.hover()
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0)
})

test("Seedance 2.5 starts at 480p and a 4 s draft shows no cost warning", async ({
  page,
}) => {
  await signIn(page, uniqueEmail("or-cost"), "/video")
  await page.goto("/video?model=seedance-2.5-openrouter")
  await dismissCookies(page)
  await page
    .getByRole("textbox", { name: /Prompt|Describe/ })
    .first()
    .fill("A long cinematic dolly shot")
  await expect(page.getByText("480p").first()).toBeVisible()
  // 4 s at 480p is below the warning threshold.
  await expect(page.getByText(/Costly run/)).toHaveCount(0)
})
