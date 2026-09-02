import { bench, describe } from "vitest"
import { normalizeMessage } from "../src/core/message.ts"
import { buildMime, dotStuff, toMimeInput } from "../src/drivers/_mime.ts"
import { attachmentToBase64, bytesToBase64 } from "../src/drivers/_base64.ts"
import { signDkim } from "../src/drivers/_smtp/dkim.ts"
import { htmlToText } from "../src/render/html.ts"

/**
 * The SMTP and SES hot path: assembling the RFC 5322 document, and signing
 * it. Everything here is pure CPU, so these are the numbers that decide how
 * many messages a single worker can push.
 *
 * @module
 */

const base = { from: "Acme <hi@acme.com>", to: "Ada <ada@example.com>", subject: "Welcome" }
const HTML = `<html><body>${"<p>Thanks for signing up. Here is what happens next.</p>".repeat(20)}</body></html>`

const mime = (over: Parameters<typeof normalizeMessage>[0]) =>
  toMimeInput(normalizeMessage(over), "<1@acme.com>")

const textOnly = mime({ ...base, text: "hello" })
const alternative = mime({ ...base, text: "hello", html: HTML })
const nonAscii = mime({
  ...base,
  subject: "Zusammenfassung Ihrer Bestellung — Straßenbahnfahrscheine",
  text: "Grüße aus München. ".repeat(50),
})
const withAttachment = mime({
  ...base,
  text: "see attached",
  attachments: [
    {
      filename: "invoice.pdf",
      content: new Uint8Array(256 * 1024),
      contentType: "application/pdf",
    },
  ],
})

describe("buildMime", () => {
  bench("text only", () => {
    buildMime(textOnly)
  })

  bench("multipart/alternative", () => {
    buildMime(alternative)
  })

  // Quoted-printable escapes byte by byte, and the subject needs RFC 2047
  // encoded-words, so this is the slow shape.
  bench("non-ASCII body and subject", () => {
    buildMime(nonAscii)
  })

  bench("multipart/mixed with a 256 KB attachment", () => {
    buildMime(withAttachment)
  })
})

describe("wire encoding", () => {
  const rendered = buildMime(alternative).body
  bench("dotStuff a rendered document", () => {
    dotStuff(rendered)
  })

  for (const size of [16 * 1024, 256 * 1024, 4 * 1024 * 1024]) {
    const bytes = new Uint8Array(size)
    bench(`base64 ${size / 1024} KB`, () => {
      bytesToBase64(bytes)
    })
  }

  const text = "x".repeat(64 * 1024)
  bench("base64 a 64 KB text attachment", () => {
    attachmentToBase64({ filename: "a.txt", content: text })
  })
})

// Generated at module scope rather than in a hook: `beforeAll` does not run
// before a bench callback, so the keys would be undefined on every iteration.
const rsaKey = (
  (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
).privateKey
const ed25519Key = (
  (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
).privateKey
const document = buildMime(alternative).body

describe("DKIM", () => {
  bench("rsa-sha256", async () => {
    await signDkim(document, { selector: "s1", domain: "acme.com", privateKey: rsaKey })
  })

  // RFC 8463's reason for existing: the signature is a fraction of the size
  // and the signing is cheaper, which matters when every message pays it.
  bench("ed25519-sha256", async () => {
    await signDkim(document, {
      selector: "s1",
      domain: "acme.com",
      privateKey: ed25519Key,
      algorithm: "ed25519-sha256",
    })
  })
})

describe("htmlToText", () => {
  bench("derive the text alternative", () => {
    htmlToText(HTML)
  })
})
