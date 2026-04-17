import { describe, expect, it, beforeAll } from "vitest"
import { signDkim } from "../../src/drivers/_smtp/dkim.ts"

async function generatePkcs8Rsa(): Promise<{ privatePem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const b64 = bytesToBase64(pkcs8)
  const pem = `-----BEGIN PRIVATE KEY-----\n${chunk(b64, 64).join("\n")}\n-----END PRIVATE KEY-----`
  return { privatePem: pem, publicKey: pair.publicKey }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function chunk(s: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

describe("signDkim", () => {
  let privatePem = ""
  let publicKey: CryptoKey
  const msg = [
    "From: ada@example.com",
    "To: bob@example.com",
    "Subject: hi",
    "Date: Fri, 1 May 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello world.",
    "",
  ].join("\r\n")

  beforeAll(async () => {
    const g = await generatePkcs8Rsa()
    privatePem = g.privatePem
    publicKey = g.publicKey
  })

  it("adds a DKIM-Signature header at the top of the message", async () => {
    const signed = await signDkim(msg, {
      selector: "s1",
      domain: "example.com",
      privateKey: privatePem,
    })
    expect(signed.startsWith("DKIM-Signature: ")).toBe(true)
    expect(signed).toContain("a=rsa-sha256")
    expect(signed).toContain("c=relaxed/relaxed")
    expect(signed).toContain("d=example.com")
    expect(signed).toContain("s=s1")
    expect(signed).toContain("bh=")
    expect(signed).toContain("b=")
  })

  it("produces a verifiable RSA signature over canonicalized headers", async () => {
    const signed = await signDkim(msg, {
      selector: "s1",
      domain: "example.com",
      privateKey: privatePem,
      headers: ["From", "To", "Subject", "Date"],
    })
    // Parse the DKIM-Signature we just added back out.
    const first = signed.slice(0, signed.indexOf("\r\n"))
    const fields = parseDkimHeaderValue(first)
    expect(fields.v).toBe("1")
    expect(fields.a).toBe("rsa-sha256")

    // Rebuild what should have been signed, and verify.
    const headersUsed = fields.h!.split(":")
    const sep = signed.indexOf("\r\n\r\n")
    const headerBlock = signed.slice(0, sep)
    const parsed = parseHeadersForTest(headerBlock)

    const toSign = [
      ...headersUsed
        .map((n) => parsed.find((h) => h.name.toLowerCase() === n.toLowerCase()))
        .filter((h): h is { name: string; value: string } => Boolean(h))
        .map((h) => canonHeader(h.name, h.value)),
      canonHeader(
        "DKIM-Signature",
        first.slice(first.indexOf(":") + 1).replace(/b=[^;]*$/, "b="),
      ).replace(/\r\n$/, ""),
    ].join("")

    const sig = base64ToBytes(fields.b!)
    const ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      sig as BufferSource,
      new TextEncoder().encode(toSign) as BufferSource,
    )
    expect(ok).toBe(true)
  })
})

function parseDkimHeaderValue(headerLine: string): Record<string, string> {
  const value = headerLine.slice(headerLine.indexOf(":") + 1).trim()
  const out: Record<string, string> = {}
  for (const part of value.split(/;\s*/)) {
    if (!part) continue
    const eq = part.indexOf("=")
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

function parseHeadersForTest(block: string): Array<{ name: string; value: string }> {
  const lines = block.split(/\r\n/)
  const out: Array<{ name: string; value: string }> = []
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

function canonHeader(name: string, value: string): string {
  const canon = value
    .replace(/\r\n/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+$/g, "")
    .replace(/^[ \t]+/g, "")
  return `${name.toLowerCase().trim()}:${canon}\r\n`
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const buf = new ArrayBuffer(bin.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
