import { bench, describe } from "vitest"
import { normalizeMessage } from "../src/core/message.ts"
import { formatAddress, parseAddress, toAddressList } from "../src/core/address.ts"

/**
 * `normalizeMessage` runs exactly once per message, on the way in. For a
 * 100k-message campaign it is the only work the core does per message that
 * is not the provider's, so it is the one place where core overhead is
 * visible at all.
 *
 * @module
 */

const minimal = { from: "hi@acme.com", to: "ada@example.com", subject: "s", text: "t" }

const typical = {
  from: "Acme <hi@acme.com>",
  to: "Ada Lovelace <ada@example.com>",
  replyTo: "support@acme.com",
  subject: "Your invoice is ready",
  preheader: "Invoice #1042 · due in 14 days",
  text: "Your invoice is attached.",
  html: "<html><body><p>Your invoice is attached.</p></body></html>",
  headers: { "X-Campaign": "billing" },
  tags: [{ name: "campaign", value: "billing" }],
  metadata: { userId: "42" },
  unsubscribe: { url: "https://acme.com/u/42" },
}

const fanOut = {
  from: "hi@acme.com",
  subject: "s",
  text: "t",
  to: Array.from({ length: 50 }, (_, i) => `user${i}@example.com`),
  cc: Array.from({ length: 10 }, (_, i) => `cc${i}@example.com`),
}

const withAttachments = {
  ...minimal,
  attachments: Array.from({ length: 5 }, (_, i) => ({
    filename: `page-${i}.pdf`,
    content: new Uint8Array(64 * 1024),
    contentType: "application/pdf",
  })),
}

describe("normalizeMessage", () => {
  bench("minimal", () => {
    normalizeMessage(minimal)
  })

  bench("typical — preheader, unsubscribe, tags, metadata", () => {
    normalizeMessage(typical)
  })

  bench("60 recipients across to and cc", () => {
    normalizeMessage(fanOut)
  })

  // Attachments are carried by reference, so this should cost the same as
  // `minimal`. If it ever does not, something is copying the bytes.
  bench("5 × 64 KB attachments", () => {
    normalizeMessage(withAttachments)
  })

  bench("with instance defaults to merge", () => {
    normalizeMessage(minimal, {
      from: "fallback@acme.com",
      headers: { "X-Env": "prod" },
      tags: [{ name: "env", value: "prod" }],
    })
  })
})

describe("addresses", () => {
  bench("parseAddress — bare", () => {
    parseAddress("ada@example.com")
  })

  bench("parseAddress — display name", () => {
    parseAddress("Ada Lovelace <ada@example.com>")
  })

  bench("formatAddress — needs quoting", () => {
    formatAddress({ email: "ada@example.com", name: "Lovelace, Ada" })
  })

  bench("toAddressList — 50 mixed", () => {
    toAddressList(fanOut.to)
  })
})
