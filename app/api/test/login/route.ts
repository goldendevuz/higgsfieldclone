import { collections } from "@/lib/db/collections"
import { env } from "@/lib/env"
import { json } from "@/lib/http"

/**
 * Local development only: skips opening the mailbox by redirecting to the
 * latest magic link stored for an address. Needs NODE_ENV=development and
 * E2E_TEST_MODE; never available on Vercel or in production.
 */
export async function GET(request: Request) {
  const value = env()
  if (
    value.NODE_ENV !== "development" ||
    !value.E2E_TEST_MODE ||
    process.env.VERCEL_ENV
  )
    return json({ error: "Not found" }, 404)
  const to = new URL(request.url).searchParams.get("to")?.toLowerCase()
  if (!to) return json({ error: "Missing ?to=" }, 400)
  const { devMailbox } = await collections()
  const mail = await devMailbox.findOne({ to }, { sort: { createdAt: -1 } })
  if (!mail) return json({ error: "No mail" }, 404)
  return Response.redirect(mail.url, 302)
}
