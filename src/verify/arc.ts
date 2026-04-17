/**
 * Minimal ARC (RFC 8617) signer — ships just enough to produce a
 * valid ARC-Set (ARC-Authentication-Results, ARC-Message-Signature,
 * ARC-Seal) for an intermediary. Uses Web Crypto, no deps.
 *
 * Scope: sign-only. Verification happens at the final receiver; this
 * module helps the middle hop preserve auth-chain provenance.
 *
 * @module
 */

export type ArcAlgorithm = "rsa-sha256" | "ed25519-sha256"

export interface ArcSignerOptions {
  selector: string
  domain: string
  privateKey: string | CryptoKey
  algorithm?: ArcAlgorithm
  /** Current instance number (i=). Required — the intermediary
   *  increments it each hop, starting at 1. */
  instance: number
  /** Authentication-Results payload as you observed it. e.g.
   *  `"dkim=pass header.d=acme.com; spf=pass"`. */
  authResults: string
  /** Headers to include in the ARC-Message-Signature body. */
  signedHeaders?: ReadonlyArray<string>
}

export interface ArcHeaders {
  "ARC-Authentication-Results": string
  "ARC-Message-Signature": string
  "ARC-Seal": string
}

/** Produce the three ARC headers for one hop. Caller prepends them to
 *  the outgoing message headers. Returns strings without trailing
 *  CRLF. */
export async function signArc(message: string, options: ArcSignerOptions): Promise<ArcHeaders> {
  const alg = options.algorithm ?? "rsa-sha256"
  const { instance, selector, domain, authResults } = options
  const sep = message.indexOf("\r\n\r\n")
  if (sep < 0) throw new Error("[unemail/arc] message must contain CRLF CRLF separator")
  const headersBlock = message.slice(0, sep)
  const body = message.slice(sep + 4)

  const authLine = `ARC-Authentication-Results: i=${instance}; ${authResults}`
  const bodyHash = await sha256Base64(canonBody(body))

  const amsFields = {
    i: String(instance),
    a: alg,
    c: "relaxed/relaxed",
    d: domain,
    s: selector,
    t: Math.floor(Date.now() / 1000).toString(),
    bh: bodyHash,
    h: (options.signedHeaders ?? ["From", "To", "Subject", "Date"]).join(":"),
    b: "",
  }
  const amsValue = serializeFields(amsFields)
  const amsHeader = `ARC-Message-Signature: ${amsValue}`
  const amsSig = await signHeader(
    message,
    amsHeader,
    options.signedHeaders ?? ["From", "To", "Subject", "Date"],
    options.privateKey,
    alg,
    headersBlock,
  )
  const amsFinal = `ARC-Message-Signature: ${amsValue.replace(/b=$/, `b=${amsSig}`)}`

  const asFields = {
    i: String(instance),
    a: alg,
    cv: instance === 1 ? "none" : "pass",
    d: domain,
    s: selector,
    t: Math.floor(Date.now() / 1000).toString(),
    b: "",
  }
  const asValue = serializeFields(asFields)
  const asBase = `${authLine}\r\n${amsFinal}\r\nARC-Seal: ${asValue}`
  const asSig = await signString(asBase.replace(/b=$/, "b="), options.privateKey, alg)
  const asFinal = `ARC-Seal: ${asValue.replace(/b=$/, `b=${asSig}`)}`

  return {
    "ARC-Authentication-Results": authLine.slice("ARC-Authentication-Results: ".length),
    "ARC-Message-Signature": amsFinal.slice("ARC-Message-Signature: ".length),
    "ARC-Seal": asFinal.slice("ARC-Seal: ".length),
  }
}

async function signHeader(
  _message: string,
  _amsHeader: string,
  signed: ReadonlyArray<string>,
  key: string | CryptoKey,
  alg: ArcAlgorithm,
  headersBlock: string,
): Promise<string> {
  const parsed = parseHeaders(headersBlock)
  const canon = signed
    .map((n) => parsed.find((h) => h.name.toLowerCase() === n.toLowerCase()))
    .filter((h): h is { name: string; value: string } => Boolean(h))
    .map(
      (h) =>
        `${h.name.toLowerCase()}:${h.value
          .replace(/\r\n/g, "")
          .replace(/[ \t]+/g, " ")
          .trim()}\r\n`,
    )
    .join("")
  return signString(canon, key, alg)
}

async function signString(
  value: string,
  key: string | CryptoKey,
  alg: ArcAlgorithm,
): Promise<string> {
  const imported = await importKey(key, alg)
  const algo: AlgorithmIdentifier =
    alg === "ed25519-sha256"
      ? ({ name: "Ed25519" } as unknown as AlgorithmIdentifier)
      : { name: "RSASSA-PKCS1-v1_5" }
  const sig = await crypto.subtle.sign(
    algo,
    imported,
    new TextEncoder().encode(value) as BufferSource,
  )
  return bytesToBase64(new Uint8Array(sig))
}

async function importKey(key: string | CryptoKey, alg: ArcAlgorithm): Promise<CryptoKey> {
  if (typeof key !== "string") return key
  const b64 = key
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "")
  const der = base64ToBytes(b64)
  if (alg === "ed25519-sha256") {
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

function canonBody(body: string): string {
  const lines = body.split(/\r\n/)
  while (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return "\r\n"
  return lines.map((l) => l.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, "")).join("\r\n") + "\r\n"
}

function parseHeaders(block: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  const lines = block.split(/\r\n/)
  let current: { name: string; value: string } | null = null
  for (const line of lines) {
    if (!line) continue
    if (/^[ \t]/.test(line)) {
      if (current) current.value += "\r\n" + line
      continue
    }
    if (current) out.push(current)
    const colon = line.indexOf(":")
    if (colon < 0) continue
    current = { name: line.slice(0, colon), value: line.slice(colon + 1) }
  }
  if (current) out.push(current)
  return out
}

function serializeFields(fields: Record<string, string>): string {
  const order = ["i", "a", "c", "cv", "d", "s", "t", "bh", "h", "b"]
  const parts: string[] = []
  for (const k of order) if (fields[k] !== undefined) parts.push(`${k}=${fields[k]}`)
  return parts.join("; ")
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as BufferSource,
  )
  return bytesToBase64(new Uint8Array(digest))
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
