/** Azure Communication Services access-key authentication (fetch edition).
 *
 *  A data-plane request is signed with HMAC-SHA256 over three lines — the
 *  verb, the path with its query, and the values of `x-ms-date`, `host` and
 *  `x-ms-content-sha256` joined by semicolons — and sent as
 *  `Authorization: HMAC-SHA256 SignedHeaders=…&Signature=…`. The key from
 *  the portal is base64 and is decoded before it is used as the HMAC key.
 *
 *  Scheme documented at
 *  https://learn.microsoft.com/en-us/azure/communication-services/tutorials/hmac-header-tutorial
 *
 *  Web Crypto only — no `node:crypto`, no `@azure/*` — so it runs on Node,
 *  Bun, Deno, Cloudflare Workers and in a browser.
 *
 * @module
 */

import { bytesToBase64 } from "../_base64.ts"

/** A resource endpoint and the base64 key that signs requests to it. */
export interface AzureCredentials {
  /** Resource endpoint, without a trailing slash. */
  endpoint: string
  /** Access key, base64, exactly as the portal prints it. */
  accessKey: string
}

export interface AzureSignInit {
  method: string
  url: string
  /** The serialized body, byte-for-byte as it will be sent. Absent is
   *  signed as the empty string, which is what a GET needs. */
  body?: string
  headers?: Record<string, string>
  /** Base64 access key. */
  accessKey: string
  /** Override the signing time — defaults to `new Date()`. Used for tests. */
  now?: () => Date
}

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** The headers the signature covers, in the order it covers them. */
const SIGNED_HEADERS = "x-ms-date;host;x-ms-content-sha256"

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const encoder = new TextEncoder()

/** Produce a ready-to-fetch signed request. `host` is not returned: it is a
 *  forbidden request header, so `fetch` writes it, but the signature still
 *  covers the value the URL implies. */
export async function signRequest(init: AzureSignInit): Promise<SignedRequest> {
  const url = new URL(init.url)
  const method = init.method.toUpperCase()
  // `toUTCString` is specified to emit exactly the RFC 1123 form Azure wants.
  const date = (init.now ?? (() => new Date()))().toUTCString()
  const contentHash = await sha256Base64(init.body ?? "")

  const stringToSign = `${method}\n${url.pathname}${url.search}\n${date};${url.host};${contentHash}`
  const signature = await hmacBase64(decodeAccessKey(init.accessKey), stringToSign)

  return {
    url: init.url,
    method,
    headers: {
      ...init.headers,
      "x-ms-date": date,
      "x-ms-content-sha256": contentHash,
      authorization: `HMAC-SHA256 SignedHeaders=${SIGNED_HEADERS}&Signature=${signature}`,
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  }
}

/**
 * Split the connection string the portal's Keys blade prints:
 * `endpoint=https://my-resource.communication.azure.com/;accesskey=<base64>`.
 *
 * Returns `null` for anything malformed rather than throwing, so the caller
 * can raise an error tagged with its own driver name.
 */
export function parseConnectionString(value: string): AzureCredentials | null {
  let endpoint = ""
  let accessKey = ""

  for (const part of value.split(";")) {
    const segment = part.trim()
    if (!segment) continue
    const at = segment.indexOf("=")
    if (at < 1) return null
    const name = segment.slice(0, at).trim().toLowerCase()
    // Only the first `=` separates: a base64 key ends in one or two of them.
    const item = segment.slice(at + 1).trim()
    if (name === "endpoint") endpoint = item
    else if (name === "accesskey") accessKey = item
  }

  if (!endpoint || !isAccessKey(accessKey)) return null

  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null

  return { endpoint: endpoint.replace(/\/+$/, ""), accessKey }
}

/** Whether a string can be the base64 key Azure issues. Checked up front
 *  because a key that fails to decode signs every request wrong, and Azure
 *  answers that with a bare 401. */
export function isAccessKey(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64.test(value)
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value) as BufferSource)
  return bytesToBase64(new Uint8Array(digest))
}

async function hmacBase64(key: Uint8Array, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(data) as BufferSource,
  )
  return bytesToBase64(new Uint8Array(signature))
}

function decodeAccessKey(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
