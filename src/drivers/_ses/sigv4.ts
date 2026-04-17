/** Minimal AWS Signature V4 (fetch edition).
 *
 *  Implements exactly what the SES v2 SendEmail / SendBulkEmail calls need:
 *  SHA-256 + HMAC-SHA256 via Web Crypto, payload hashing, canonical request,
 *  string-to-sign, signing key derivation. No service-specific behavior — you
 *  pass the region, service, credentials, and payload.
 *
 *  Works on Node ≥20, Bun, Deno, Cloudflare Workers, and modern browsers.
 */

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignInit {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  region: string
  service: string
  credentials: AwsCredentials
  /** Override the signing time — defaults to `new Date()`. Used for tests. */
  now?: () => Date
}

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

const encoder = new TextEncoder()

/** Produce a ready-to-fetch signed request. */
export async function signRequest(init: SignInit): Promise<SignedRequest> {
  const now = (init.now ?? (() => new Date()))()
  const amzDate = formatAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const url = new URL(init.url)
  const body = init.body ?? ""
  const payloadHash = await sha256Hex(body)

  const baseHeaders: Record<string, string> = {
    ...init.headers,
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  }
  if (init.credentials.sessionToken)
    baseHeaders["x-amz-security-token"] = init.credentials.sessionToken

  const canonicalHeaders = Object.entries(baseHeaders)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const signedHeaders = canonicalHeaders.map(([k]) => k).join(";")
  const canonicalHeadersStr = canonicalHeaders.map(([k, v]) => `${k}:${v}\n`).join("")

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`)
    .join("&")

  const canonicalRequest = [
    init.method.toUpperCase(),
    uriEncode(url.pathname || "/", false),
    canonicalQuery,
    canonicalHeadersStr,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const credentialScope = `${dateStamp}/${init.region}/${init.service}/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n")

  const signingKey = await deriveSigningKey(
    init.credentials.secretAccessKey,
    dateStamp,
    init.region,
    init.service,
  )
  const signature = bytesToHex(await hmac(signingKey, stringToSign))

  const authHeader = `AWS4-HMAC-SHA256 Credential=${init.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: init.url,
    method: init.method,
    headers: { ...baseHeaders, authorization: authHeader },
    body: init.body,
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value) as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<Uint8Array> {
  const keyBuf = (key instanceof Uint8Array ? key : new Uint8Array(key)) as BufferSource
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data) as BufferSource)
  return new Uint8Array(sig)
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), dateStamp)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, "aws4_request")
  return kSigning
}

function formatAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "")
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

function uriEncode(value: string, encodeSlash: boolean): string {
  let out = ""
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch
    else if (ch === "/" && !encodeSlash) out += ch
    else {
      for (const byte of encoder.encode(ch))
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}
