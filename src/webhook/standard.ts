/**
 * Reference implementation of the Standard Webhooks protocol
 * (https://standardwebhooks.com). Zero-dep, Web-Crypto only, <5 kB.
 *
 * Used by Resend (and growing in adoption). Drop-in replacement for
 * the Svix client when you only need signature verification.
 *
 * @module
 */

import { b64ToBytes, timingSafeEqual } from "./_crypto.ts"

const encoder = /* @__PURE__ */ new TextEncoder()
const TOLERANCE_SECONDS = 5 * 60

export interface StandardWebhookOptions {
  /** Webhook secret. `whsec_` prefix is accepted and stripped. */
  secret: string
  /** Max age of the timestamp the verifier will accept. Default:
   *  5 minutes (same as the Svix reference). */
  toleranceSeconds?: number
  /** Clock source — injected for tests. Default: `Date.now`. */
  now?: () => number
}

/** Verify a Standard Webhooks request. Pass the raw HTTP request (or
 *  an adapter with `headers.get()` + `text()`). Resolves the payload
 *  on success, rejects with an `Error` on signature failure / stale
 *  timestamp. */
export async function verifyStandardWebhook(
  request: Request,
  options: StandardWebhookOptions,
): Promise<string> {
  const msgId = request.headers.get("webhook-id")
  const timestamp = request.headers.get("webhook-timestamp")
  const signatures = request.headers.get("webhook-signature")
  if (!msgId || !timestamp || !signatures)
    throw new Error("[unemail/webhook/standard] missing webhook-* headers")

  const now = options.now ?? Date.now
  const tolerance = options.toleranceSeconds ?? TOLERANCE_SECONDS
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(now() / 1000 - ts) > tolerance)
    throw new Error("[unemail/webhook/standard] timestamp outside tolerance window")

  const body = await request.text()
  const expected = await computeSignature(
    stripPrefix(options.secret),
    `${msgId}.${timestamp}.${body}`,
  )
  for (const part of signatures.split(/\s+/)) {
    const [version, sig] = part.split(",", 2)
    if (version !== "v1" || !sig) continue
    if (timingSafeEqual(sig, expected)) return body
  }
  throw new Error("[unemail/webhook/standard] signature mismatch")
}

/** Sign a payload for tests or self-sending. Returns the value you'd
 *  put in the `webhook-signature` header. */
export async function signStandardWebhook(
  secret: string,
  msgId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const sig = await computeSignature(stripPrefix(secret), `${msgId}.${timestamp}.${body}`)
  return `v1,${sig}`
}

function stripPrefix(secret: string): string {
  return secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
}

async function computeSignature(secretBase64: string, message: string): Promise<string> {
  const keyBytes = b64ToBytes(secretBase64)
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message) as BufferSource)
  return bytesToBase64(new Uint8Array(sig))
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
