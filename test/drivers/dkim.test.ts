import { beforeAll, describe, expect, it } from "vitest"
import { signDkim } from "../../src/drivers/_smtp/dkim.ts"

/**
 * These tests do not compare the signer against itself. They re-derive the
 * body hash and the signed header block straight from RFC 6376, and then
 * verify the signature with Web Crypto — so agreement is evidence that a
 * real verifier would accept the message, not that the code is consistent
 * with its own bugs.
 */

const MESSAGE = [
  "From: Acme <hi@acme.com>",
  "To: Ada <ada@example.com>",
  "Subject: Welcome",
  "Date: Tue, 01 Sep 2026 12:00:00 GMT",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello   there  \r\nsecond line\r\n\r\n\r\n",
].join("\r\n")

let rsa: CryptoKeyPair
let ed25519: CryptoKeyPair

beforeAll(async () => {
  rsa = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  ed25519 = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
})

// ---------------------------------------------------------------------------
// RFC 6376 §3.4.3 / §3.4.4, reimplemented here from the spec.
// ---------------------------------------------------------------------------

/** Relaxed body canonicalization: normalize whitespace runs, strip trailing
 *  whitespace per line, drop trailing empty lines, end with one CRLF. */
function canonBodyRelaxed(body: string): string {
  let out = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
    .join("\r\n")
  out = out.replace(/(\r\n)+$/, "")
  return out === "" ? "" : `${out}\r\n`
}

/** Relaxed header canonicalization: lowercase the name, unfold, collapse
 *  whitespace runs, strip around the colon. */
function canonHeaderRelaxed(name: string, value: string): string {
  const unfolded = value
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
  return `${name.toLowerCase()}:${unfolded}`
}

const b64 = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString("base64")

async function sha256B64(value: string): Promise<string> {
  return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
}

function splitSigned(signed: string) {
  const sep = signed.indexOf("\r\n\r\n")
  const headerBlock = signed.slice(0, sep)
  const body = signed.slice(sep + 4)

  const lines = headerBlock.split("\r\n")
  const headers: { name: string; value: string }[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += `\r\n${line}`
      continue
    }
    const at = line.indexOf(":")
    if (at > 0) headers.push({ name: line.slice(0, at), value: line.slice(at + 1) })
  }

  const signature = headers.find((h) => h.name.toLowerCase() === "dkim-signature")!
  const tags = Object.fromEntries(
    signature.value
      .replace(/\r\n[ \t]+/g, "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=")
        return [part.slice(0, eq).trim(), part.slice(eq + 1).replace(/\s+/g, "")]
      }),
  ) as Record<string, string>

  return { headers, signature, tags, body }
}

/** Rebuild exactly what RFC 6376 §3.7 says was signed. */
function signedData(signed: string): string {
  const { headers, signature, tags } = splitSigned(signed)
  const covered = tags.h!.split(":")
  const parts = covered.map((name) => {
    const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())!
    return canonHeaderRelaxed(header.name, header.value)
  })
  // The DKIM-Signature header itself, with an empty b= and no trailing CRLF.
  const emptied = signature.value.replace(/b=[^;]*/, "b=")
  parts.push(canonHeaderRelaxed("dkim-signature", emptied))
  return parts.join("\r\n")
}

async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = b64(await crypto.subtle.exportKey("pkcs8", key))
  return `-----BEGIN PRIVATE KEY-----\n${der.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`
}

describe("signDkim", () => {
  it("prepends a DKIM-Signature header and leaves the message otherwise intact", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "s1",
      domain: "acme.com",
      privateKey: rsa.privateKey,
    })
    expect(signed.startsWith("DKIM-Signature:")).toBe(true)
    expect(signed).toContain("Subject: Welcome")
    expect(signed.slice(signed.indexOf("\r\n\r\n") + 4)).toBe(
      MESSAGE.slice(MESSAGE.indexOf("\r\n\r\n") + 4),
    )
  })

  it("declares the tags a verifier needs", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "sel",
      domain: "acme.com",
      privateKey: rsa.privateKey,
    })
    const { tags } = splitSigned(signed)
    expect(tags.v).toBe("1")
    expect(tags.a).toBe("rsa-sha256")
    expect(tags.c).toBe("relaxed/relaxed")
    expect(tags.d).toBe("acme.com")
    expect(tags.s).toBe("sel")
    expect(tags.bh).toBeTruthy()
    expect(tags.b).toBeTruthy()
  })

  it("computes bh= over the relaxed-canonicalized body, per RFC 6376 §3.4.4", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "s1",
      domain: "acme.com",
      privateKey: rsa.privateKey,
    })
    const { tags, body } = splitSigned(signed)
    expect(tags.bh).toBe(await sha256B64(canonBodyRelaxed(body)))
  })

  it("produces an rsa-sha256 signature a verifier accepts", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "s1",
      domain: "acme.com",
      privateKey: rsa.privateKey,
    })
    const { tags } = splitSigned(signed)
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      rsa.publicKey,
      Buffer.from(tags.b!, "base64"),
      new TextEncoder().encode(signedData(signed)),
    )
    expect(valid).toBe(true)
  })

  it("produces an ed25519-sha256 signature a verifier accepts (RFC 8463)", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "s1",
      domain: "acme.com",
      privateKey: ed25519.privateKey,
      algorithm: "ed25519-sha256",
    })
    const { tags } = splitSigned(signed)
    expect(tags.a).toBe("ed25519-sha256")
    const valid = await crypto.subtle.verify(
      "Ed25519",
      ed25519.publicKey,
      Buffer.from(tags.b!, "base64"),
      new TextEncoder().encode(signedData(signed)),
    )
    expect(valid).toBe(true)
  })

  it("accepts a PEM private key, not only a CryptoKey", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "s1",
      domain: "acme.com",
      privateKey: await pkcs8Pem(rsa.privateKey),
    })
    const { tags } = splitSigned(signed)
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      rsa.publicKey,
      Buffer.from(tags.b!, "base64"),
      new TextEncoder().encode(signedData(signed)),
    )
    expect(valid).toBe(true)
  })

  it("signs only the headers named in h=", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "s1",
      domain: "acme.com",
      privateKey: rsa.privateKey,
      headers: ["From", "Subject"],
    })
    const { tags } = splitSigned(signed)
    expect(tags.h!.split(":").map((h) => h.toLowerCase())).toEqual(["from", "subject"])
  })

  it("detects a body tampered with after signing", async () => {
    const signed = await signDkim(MESSAGE, {
      selector: "s1",
      domain: "acme.com",
      privateKey: rsa.privateKey,
    })
    const tampered = signed.replace("Hello", "Goodbye")
    const { tags, body } = splitSigned(tampered)
    expect(tags.bh).not.toBe(await sha256B64(canonBodyRelaxed(body)))
  })

  it("refuses a message with no header/body separator", async () => {
    await expect(
      signDkim("From: a@b.com\r\nSubject: no body separator", {
        selector: "s1",
        domain: "acme.com",
        privateKey: rsa.privateKey,
      }),
    ).rejects.toThrow(/CRLF/)
  })
})
