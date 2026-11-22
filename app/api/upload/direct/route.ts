import { errorResponse } from "@/lib/http"
import { receiveDirectUpload } from "@/lib/uploads"

export const runtime = "nodejs"

/**
 * Upload target used when no Higgsfield key issues platform upload URLs (an
 * OpenRouter-only deployment). The URL is minted by POST /api/upload for a
 * signed-in user and carries an HMAC over its key, type and expiry; browsers
 * send no cookies to upload URLs, so the signature is the authorization.
 * The file lands in our storage (R2, or .data/media in development).
 */
export async function PUT(request: Request) {
  try {
    await receiveDirectUpload(
      new URL(request.url).searchParams,
      request.headers.get("content-type"),
      request.body
    )
    return new Response(null, { status: 204 })
  } catch (caught) {
    return errorResponse(caught)
  }
}
