/**
 * RFC 6376 (RSA-SHA256) + RFC 8463 (Ed25519-SHA256) DKIM signer.
 *
 * Ships relaxed/relaxed canonicalization because it's what gmail,
 * yahoo, outlook and every popular mail server prefer in 2026. Uses
 * Web Crypto throughout — no node:crypto — so the SMTP driver can run
 * on Cloudflare Workers if you bring your own socket transport.
 *
 * @module
 */

export interface DkimSignerOptions {
  /** DNS selector — the TXT record at `<selector>._domainkey.<domain>`. */
  selector: string
  /** Signing domain. */
  domain: string
  /** Private key as PEM, or a pre-imported `CryptoKey`. RSA accepts both
   *  PKCS8 (`BEGIN PRIVATE KEY`) and PKCS1 (`BEGIN RSA PRIVATE KEY`, what
   *  `openssl genrsa` writes); Ed25519 must be PKCS8. */
  privateKey: string | CryptoKey
  /** Signing algorithm. Default: `rsa-sha256`. */
  algorithm?: "rsa-sha256" | "ed25519-sha256"
  /** Headers to include in the signature. Default set is the canonical
   *  minimal list recommended by RFC 6376. */
  headers?: ReadonlyArray<string>
}

/** Per-message signer. Takes a built RFC 5322 message (headers + CRLF +
 *  body) and returns a new message with a leading `DKIM-Signature:`
 *  header. */
/** DER: a definite-length header for `tag` around `length` content bytes. */
function derHeader(tag: number, length: number): number[] {
  if (length < 0x80) return [tag, length]
  const bytes: number[] = []
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff)
  return [tag, 0x80 | bytes.length, ...bytes]
}

/**
 * Wrap a PKCS1 RSA key in the PKCS8 envelope Web Crypto requires.
 *
 * `openssl genrsa` writes PKCS1 (`BEGIN RSA PRIVATE KEY`), which is what
 * most DKIM key recipes produce, and Web Crypto has no PKCS1 import format
 * at all — it fails with an unhelpful `Invalid keyData`. The envelope is
 * PrivateKeyInfo from RFC 5208: version 0, the rsaEncryption algorithm
 * identifier, then the PKCS1 key as an OCTET STRING.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00]
  // AlgorithmIdentifier { OID 1.2.840.113549.1.1.1, NULL }
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]
  const key = [...derHeader(0x04, pkcs1.length), ...pkcs1]
  const body = [...version, ...algorithm, ...key]
  return new Uint8Array([...derHeader(0x30, body.length), ...body])
}

export async function signDkim(message: string, options: DkimSignerOptions): Promise<string> {
  const algorithm = options.algorithm ?? "rsa-sha256"
  const headerNames = normalizeHeaderList(
    options.headers ?? ["From", "To", "Subject", "Date", "MIME-Version", "Content-Type"],
  )

  const sep = findHeaderBodySeparator(message)
  if (sep < 0) throw new Error("[unemail/dkim] message must contain CRLF CRLF separator")

  const headersBlock = message.slice(0, sep)
  const body = message.slice(sep + 4)

  const parsedHeaders = parseHeaders(headersBlock)
  const canonBody = canonicalizeBodyRelaxed(body)
  const bodyHash = await sha256Base64(canonBody)

  const signedHeaderList = headerNames
    .filter((n) => parsedHeaders.find((h) => h.name.toLowerCase() === n.toLowerCase()))
    .join(":")

  const dkimHeaderFields: Record<string, string> = {
    v: "1",
    a: algorithm,
    c: "relaxed/relaxed",
    d: options.domain,
    s: options.selector,
    t: Math.floor(Date.now() / 1000).toString(),
    bh: bodyHash,
    h: signedHeaderList,
    b: "",
  }
  const dkimHeaderNoSig = buildDkimHeader(dkimHeaderFields)

  const toSign = [
    ...headerNames
      .map((n) => parsedHeaders.find((h) => h.name.toLowerCase() === n.toLowerCase()))
      .filter((h): h is ParsedHeader => h !== undefined)
      .map((h) => canonicalizeHeaderRelaxed(h.name, h.value)),
    canonicalizeHeaderRelaxed("DKIM-Signature", stripHeaderName(dkimHeaderNoSig)).replace(
      /\r\n$/,
      "",
    ),
  ].join("")

  const key = await importKey(options.privateKey, algorithm)
  const signature = await signBytes(key, algorithm, new TextEncoder().encode(toSign))
  dkimHeaderFields.b = bytesToBase64(signature)

  const finalHeader = buildDkimHeader(dkimHeaderFields)
  return finalHeader + "\r\n" + message
}

interface ParsedHeader {
  name: string
  value: string
}

function parseHeaders(block: string): ParsedHeader[] {
  const out: ParsedHeader[] = []
  const lines = block.split(/\r\n/)
  let current: ParsedHeader | null = null
  for (const line of lines) {
    if (!line) continue
    if (/^[ \t]/.test(line)) {
      if (current) current.value += "\r\n" + line
      continue
    }
    if (current) out.push(current)
    const colon = line.indexOf(":")
    if (colon < 0) {
      current = null
      continue
    }
    current = { name: line.slice(0, colon), value: line.slice(colon + 1) }
  }
  if (current) out.push(current)
  return out
}

function findHeaderBodySeparator(message: string): number {
  // Accept either CRLF CRLF or LF LF (we normalize to CRLF before calling).
  const idx = message.indexOf("\r\n\r\n")
  if (idx >= 0) return idx
  return -1
}

function canonicalizeHeaderRelaxed(name: string, value: string): string {
  // Lowercase header name, unfold + collapse WSP runs in the value.
  const canonValue = value
    .replace(/\r\n/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+$/g, "")
    .replace(/^[ \t]+/g, "")
  return `${name.toLowerCase().trim()}:${canonValue}\r\n`
}

function canonicalizeBodyRelaxed(body: string): string {
  // Reduce WSP runs within lines; strip trailing WSP; strip trailing
  // empty lines. If the body is empty, return CRLF per RFC 6376.
  const lines = body.split(/\r\n/)
  // strip trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return "\r\n"
  return lines.map((l) => l.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, "")).join("\r\n") + "\r\n"
}

function buildDkimHeader(fields: Record<string, string>): string {
  const order = ["v", "a", "c", "d", "s", "t", "bh", "h", "b"]
  const parts: string[] = []
  for (const k of order) {
    if (fields[k] === undefined) continue
    parts.push(`${k}=${fields[k]}`)
  }
  // Fold: keep it simple — one line. Lines >72 chars are tolerated by
  // every verifier we care about.
  return `DKIM-Signature: ${parts.join("; ")}`
}

function stripHeaderName(header: string): string {
  return header.slice(header.indexOf(":") + 1)
}

function normalizeHeaderList(names: ReadonlyArray<string>): string[] {
  return Array.from(new Set(names.map((n) => n.trim())))
}

async function sha256Base64(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return bytesToBase64(new Uint8Array(digest))
}

async function importKey(
  key: string | CryptoKey,
  algorithm: "rsa-sha256" | "ed25519-sha256",
): Promise<CryptoKey> {
  if (typeof key !== "string") return key
  const pem = key.trim()
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "")
  const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(pem)
  const der = isPkcs1 ? pkcs1ToPkcs8(base64ToBytes(b64)) : base64ToBytes(b64)
  if (algorithm === "ed25519-sha256") {
    if (isPkcs1) {
      throw new Error("[unemail/dkim] ed25519 keys must be PKCS8, not PKCS1")
    }
    return crypto.subtle.importKey(
      "pkcs8",
      der as BufferSource,
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      false,
      ["sign"],
    )
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
}

async function signBytes(
  key: CryptoKey,
  algorithm: "rsa-sha256" | "ed25519-sha256",
  data: Uint8Array,
): Promise<Uint8Array> {
  const algo: AlgorithmIdentifier =
    algorithm === "ed25519-sha256"
      ? ({ name: "Ed25519" } as unknown as AlgorithmIdentifier)
      : { name: "RSASSA-PKCS1-v1_5" }
  const sig = await crypto.subtle.sign(algo, key, data as BufferSource)
  return new Uint8Array(sig)
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const buf = new ArrayBuffer(bin.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
