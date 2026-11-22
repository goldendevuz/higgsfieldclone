import { expect, test } from "./fixtures"

import { balance, dismissCookies, signIn, uniqueEmail } from "./helpers"

/** "Expand prompt" against the mock chat endpoint (`pnpm mock:openrouter`). */
test.skip(
  process.env.E2E_OPENROUTER !== "true",
  "set E2E_OPENROUTER=true with pnpm mock:openrouter running"
)

test("Expand prompt rewrites the idea, Undo restores it, no credits spent", async ({
  page,
}) => {
  await signIn(
    page,
    uniqueEmail("expand"),
    "/video?model=seedance-2.0-mini-openrouter"
  )
  await dismissCookies(page)
  const box = page.getByRole("textbox", { name: /Prompt|Describe/ }).first()
  const expand = page.getByRole("button", { name: "Expand prompt" })
  await expect(expand).toBeDisabled()
  const before = await balance(page)
  await box.fill("create a 15sec video of an epic sci-fi scene")
  await expect(expand).toBeEnabled()
  await expand.click()
  await expect(box).toHaveValue(/Opening frame:/)
  await expect(box).toHaveValue(/Beat 1 \(0-4 s\)/)
  await page.getByRole("button", { name: "Undo" }).click()
  await expect(box).toHaveValue("create a 15sec video of an epic sci-fi scene")
  expect(await balance(page)).toBe(before)
})

test("Expand prompt shows a safe error when the provider fails", async ({
  page,
}) => {
  await signIn(
    page,
    uniqueEmail("expand-fail"),
    "/video?model=seedance-2.0-mini-openrouter"
  )
  await dismissCookies(page)
  const box = page.getByRole("textbox", { name: /Prompt|Describe/ }).first()
  await box.fill("[expand-fail] a fox")
  await page.getByRole("button", { name: "Expand prompt" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: /failed|Try again/ })
  ).toBeVisible()
  await expect(box).toHaveValue("[expand-fail] a fox")
})
