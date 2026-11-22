import { expect, test } from "./fixtures"

import { balance, dismissCookies, signIn, uniqueEmail } from "./helpers"

/**
 * Bring-your-own-key against the local OpenRouter mock. The app under test runs
 * with NO server provider keys (HF_CREDENTIALS and OPENROUTER_API_KEY empty),
 * BYOK_ENCRYPTION_KEY set, and OPENROUTER_API_BASE_URL pointing at
 * `pnpm mock:openrouter` (which accepts any `mock-*` key on GET /key).
 * Run with E2E_BYOK=true; skipped otherwise.
 */
test.skip(
  process.env.E2E_BYOK !== "true",
  "set E2E_BYOK=true with an app that has no provider keys and pnpm mock:openrouter running"
)

const MOCK = process.env.MOCK_OPENROUTER_ORIGIN ?? "http://localhost:4020"
const MODEL = "seedance-2.0-mini-openrouter"
const KEY = "mock-e2e-own-key-4242"

test("without keys the models are inactive, greyed, priced, with a Connect key button", async ({
  page,
}) => {
  await page.goto("/video")
  await dismissCookies(page)
  await expect(
    page.getByRole("heading", { name: /No video models are active/ })
  ).toBeVisible()
  const row = page.locator(`[data-model-id="${MODEL}"]`)
  await expect(row).toBeVisible()
  await expect(row).toContainText("Needs your OpenRouter key")
  await expect(row).toContainText(/from ✦\d+/)
  // Not selectable: no button for the model itself, only the Connect link.
  await expect(row.getByRole("button")).toHaveCount(0)
  const connect = row.getByRole("link", { name: "Connect key" })
  await expect(connect).toHaveAttribute(
    "href",
    /\/account\/keys\?provider=openrouter/
  )
})

test("connect a key, use the model without credits, then delete the key", async ({
  page,
}) => {
  await signIn(page, uniqueEmail("byok"), "/video")
  const before = await balance(page)
  expect(before).toBeGreaterThan(0)

  // Inactive section reaches the settings page.
  await page.goto("/video")
  await page
    .locator(`[data-model-id="${MODEL}"]`)
    .getByRole("link", { name: "Connect key" })
    .click()
  await expect(page).toHaveURL(/\/account\/keys\?provider=openrouter/)
  await expect(page.getByTestId("openrouter-status")).toHaveText(
    "Not connected"
  )

  // A key the provider rejects is not saved.
  const input = page.getByLabel("Your key").first()
  await input.fill("sk-nope-not-a-mock-key")
  await page.getByRole("button", { name: "Save key" }).first().click()
  await expect(page.getByText(/OpenRouter rejected this key/)).toBeVisible()
  await expect(page.getByTestId("openrouter-status")).toHaveText(
    "Not connected"
  )

  // A mock-* key is accepted; only the last four characters are shown.
  await input.fill(KEY)
  await page.getByRole("button", { name: "Save key" }).first().click()
  await expect(page.getByTestId("openrouter-status")).toContainText("····4242")
  await expect(input).toHaveValue("")
  await page.reload()
  await expect(page.getByTestId("openrouter-status")).toContainText("····4242")
  expect(await page.content()).not.toContain(KEY)

  // The model is now usable and says it is billed to the key.
  await page.goto(`/video?model=${MODEL}`)
  await expect(
    page.getByRole("heading", { name: /No video models are active/ })
  ).toHaveCount(0)
  await page
    .getByRole("textbox", { name: /Prompt|Describe/ })
    .first()
    .fill("A paper boat drifting down a rain-soaked street")
  await expect(page.getByTestId("billed-to-key").first()).toContainText(
    "Billed to your OpenRouter key"
  )
  await page
    .getByRole("button", { name: /^Generate/ })
    .first()
    .click()
  await expect(
    page.getByRole("button", { name: /Open generation: A paper boat/ })
  ).toBeVisible({ timeout: 60_000 })

  // No credits were debited, and the mock saw the user's key (last four only).
  expect(await balance(page)).toBe(before)
  const seen = (await (
    await page.request.get(`${MOCK}/__mock/keys`)
  ).json()) as {
    keys: string[]
  }
  expect(seen.keys).toContain("4242")

  // Deleting the key makes the models inactive again.
  await page.goto("/account/keys")
  await page.getByRole("button", { name: "Delete" }).first().click()
  await page.getByRole("button", { name: "Yes, delete the key" }).click()
  await expect(page.getByTestId("openrouter-status")).toHaveText(
    "Not connected"
  )
  await page.goto(`/video?model=${MODEL}`)
  await expect(
    page.getByRole("heading", { name: /No video models are active/ })
  ).toBeVisible()
})
