/**
 * Deliverability and compliance helpers. Currently ships primitives for
 * RFC 2369 / RFC 8058 List-Unsubscribe: signing one-click tokens and a
 * framework-agnostic HTTP handler that verifies + dispatches to a
 * suppression store.
 *
 * @module
 */

import type { SuppressionStore } from "../suppression/index.ts"

const encoder = /* @__PURE__ */ new TextEncoder()

/** Base64url encode a byte array without padding. */
function b64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : ""
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad
  const bin = atob(std)
  const buf = new ArrayBuffer(bin.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

/** Opaque, tamper-proof token encoding the unsubscribe subject. */
export interface UnsubscribeTokenPayload {
  recipient: string
  campaign?: string
  /** Expiry as epoch seconds. Omit for non-expiring tokens. */
  exp?: number
}

/** Sign a one-click unsubscribe token with HMAC-SHA256. */
export async function signUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
  secret: string,
): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  return `${body}.${b64url(sig)}`
}

/** Verify a token. Returns the payload on success, `null` on tamper /
 *  expiry. Constant-time via Web Crypto `verify`. */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): Promise<UnsubscribeTokenPayload | null> {
  const dot = token.indexOf(".")
  if (dot < 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const key = await hmacKey(secret)
  const sigBytes = b64urlDecode(sig)
  const bodyBytes = encoder.encode(body)
  let ok: boolean
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes as BufferSource,
      bodyBytes as BufferSource,
    )
  } catch {
    return null
  }
  if (!ok) return null
  let payload: UnsubscribeTokenPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as UnsubscribeTokenPayload
  } catch {
    return null
  }
  if (payload.exp !== undefined && now() / 1000 > payload.exp) return null
  return payload
}

/** Options for `defineUnsubscribeHandler`. */
export interface UnsubscribeHandlerOptions {
  secret: string
  /** Query-string key that carries the token. Default: `t`. */
  tokenParam?: string
  /** Suppression store receiving the opt-out. */
  store?: SuppressionStore
  /** Optional hook fired after a successful unsubscribe. */
  onUnsubscribe?: (payload: UnsubscribeTokenPayload) => void | Promise<void>
  /** Custom clock for testing. */
  now?: () => number
}

/** Framework-agnostic handler — give it a `Request`, it returns a
 *  `Response`. RFC 8058 requires 200 OK on POST with no user
 *  confirmation; we honor that. GET also works for mail-client URL
 *  rendering. */
export function defineUnsubscribeHandler(
  opts: UnsubscribeHandlerOptions,
): (request: Request) => Promise<Response> {
  const param = opts.tokenParam ?? "t"
  return async (request: Request) => {
    const url = new URL(request.url)
    const token = url.searchParams.get(param)
    if (!token) return new Response("missing token", { status: 400 })
    const payload = await verifyUnsubscribeToken(token, opts.secret, opts.now)
    if (!payload) return new Response("invalid token", { status: 400 })
    await opts.store?.add(payload.recipient, "unsubscribed", payload.campaign)
    await opts.onUnsubscribe?.(payload)
    return new Response("unsubscribed", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }
}
