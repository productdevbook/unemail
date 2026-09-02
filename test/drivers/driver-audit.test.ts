import { describe, expect, it, vi } from "vitest"
import type { EmailDriver } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { attachmentToBase64 } from "../../src/drivers/_base64.ts"
import { buildMime, toMimeInput } from "../../src/drivers/_mime.ts"
import { normalizeMessage } from "../../src/core/message.ts"
import mock from "../../src/drivers/mock.ts"
import postmark from "../../src/drivers/postmark.ts"
import resend from "../../src/drivers/resend.ts"
import ses from "../../src/drivers/ses.ts"
import smtp from "../../src/drivers/smtp.ts"
import { fallback } from "../../src/drivers/fallback.ts"
import { roundRobin } from "../../src/drivers/round-robin.ts"

const msg = { to: "a@x.com", subject: "s", text: "t" } as const
const defaults = { from: "Acme <hi@acme.com>" }

function stub(payload: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const mime = (over: Parameters<typeof normalizeMessage>[0]) =>
  buildMime(toMimeInput(normalizeMessage({ from: "hi@acme.com", ...over }), "<1@a.com>"))

describe("attachment encoding is declared, not guessed", () => {
  it("treats a short string that happens to look like base64 as text", () => {
    for (const content of ["test", "abcd", "data", "Name", "MyReport", "cafe"]) {
      const encoded = attachmentToBase64({ filename: "f", content })
      expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(content)
    }
  })

  it("passes content through when the caller says it is already base64", () => {
    expect(attachmentToBase64({ filename: "f", content: "dGVzdA==", encoding: "base64" })).toBe(
      "dGVzdA==",
    )
  })

  it("encodes bytes regardless of encoding", () => {
    expect(attachmentToBase64({ filename: "f", content: new TextEncoder().encode("test") })).toBe(
      "dGVzdA==",
    )
  })

  it("reaches the wire correctly through a driver", async () => {
    const s = stub({ id: "re_1" })
    await createEmail({ driver: resend({ apiKey: "re_x", fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [{ filename: "note.txt", content: "test" }],
    })
    expect(s.calls[0]!.body.attachments[0].content).toBe("dGVzdA==")
  })

  it("reaches the MIME document correctly too", () => {
    const out = mime({ ...msg, attachments: [{ filename: "n.txt", content: "test" }] })
    expect(out.body).toContain("dGVzdA==")
  })
})

describe("MIME headers cannot be escaped or overrun", () => {
  it("splits a long non-ASCII subject into encoded-words within the RFC 2047 cap", () => {
    const subject = "Zusammenfassung Ihrer Bestellung — ".repeat(40)
    const out = mime({ ...msg, subject })

    const longest = Math.max(...out.body.split("\r\n").map((line) => line.length))
    expect(longest).toBeLessThanOrEqual(998)

    const words = out.body.match(/=\?utf-8\?B\?[^?]*\?=/g) ?? []
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75)

    const decoded = Buffer.concat(
      words.map((word) => Buffer.from(word.slice("=?utf-8?B?".length, -2), "base64")),
    ).toString("utf8")
    expect(decoded).toBe(subject)
  })

  it("still emits a short ASCII subject unencoded", () => {
    expect(mime({ ...msg, subject: "Welcome" }).headers.Subject).toBe("Welcome")
  })

  it("escapes a quote in a filename instead of letting it open a new parameter", () => {
    const out = mime({
      ...msg,
      attachments: [{ filename: 'report.txt"; filename="payload.exe', content: "AAAA" }],
    })
    const line = out.body.split("\r\n").find((l) => l.startsWith("Content-Disposition"))!
    expect(line).toBe(
      'Content-Disposition: attachment; filename="report.txt\\"; filename=\\"payload.exe"',
    )
    // The injected text stays inside the quoted value; it never becomes a
    // parameter of its own.
    expect(out.body).not.toContain('; filename="payload.exe"')
  })

  it("uses RFC 2231 for a non-ASCII filename", () => {
    const out = mime({ ...msg, attachments: [{ filename: "faturö.pdf", content: "AAAA" }] })
    expect(out.body).toContain("filename*=UTF-8''fatur%C3%B6.pdf")
  })
})

describe("resend batching", () => {
  it("carries an idempotency key derived from the messages' own keys", async () => {
    const s = stub({ data: [{ id: "a" }, { id: "b" }] })
    const send = () =>
      createEmail({ driver: resend({ apiKey: "re_x", fetch: s.fetch }), defaults }).sendBatch([
        { ...msg, idempotencyKey: "order-1" },
        { ...msg, idempotencyKey: "order-2" },
      ])

    await send()
    await send()

    const first = s.calls[0]!.headers["idempotency-key"]
    expect(first).toBeTruthy()
    // The same batch retried must present the same key, or the retry
    // duplicates every message in it.
    expect(s.calls[1]!.headers["idempotency-key"]).toBe(first)
  })

  it("sends no idempotency header when no message asked for one", async () => {
    const s = stub({ data: [{ id: "a" }, { id: "b" }] })
    await createEmail({ driver: resend({ apiKey: "re_x", fetch: s.fetch }), defaults }).sendBatch([
      msg,
      msg,
    ])
    expect(s.calls[0]!.headers["idempotency-key"]).toBeUndefined()
  })

  it("routes a batch with attachments to the single-send endpoint, which supports them", async () => {
    const s = stub({ id: "re_1" })
    const batch = await createEmail({
      driver: resend({ apiKey: "re_x", fetch: s.fetch }),
      defaults,
    }).sendBatch([
      { ...msg, attachments: [{ filename: "a.pdf", content: new Uint8Array([1]) }] },
      { ...msg, attachments: [{ filename: "b.pdf", content: new Uint8Array([2]) }] },
    ])

    expect(batch.sent).toHaveLength(2)
    expect(s.calls.map((c) => c.url)).toEqual([
      "https://api.resend.com/emails",
      "https://api.resend.com/emails",
    ])
    expect(s.calls[0]!.body.attachments).toHaveLength(1)
  })

  it("chunks at the provider's 100-message cap", async () => {
    const s = stub({ data: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}` })) })
    const batch = await createEmail({
      driver: resend({ apiKey: "re_x", fetch: s.fetch }),
      defaults,
    }).sendBatch(Array.from({ length: 150 }, (_, i) => ({ ...msg, subject: `s${i}` })))

    expect(s.calls).toHaveLength(2)
    expect(s.calls[0]!.body).toHaveLength(100)
    expect(s.calls[1]!.body).toHaveLength(50)
    expect(batch.results).toHaveLength(150)
  })
})

describe("postmark", () => {
  it("chunks at the provider's 500-message cap", async () => {
    const s = stub(Array.from({ length: 500 }, () => ({ MessageID: "m" })))
    const batch = await createEmail({
      driver: postmark({ token: "t", fetch: s.fetch }),
      defaults,
    }).sendBatch(Array.from({ length: 600 }, () => msg))

    expect(s.calls).toHaveLength(2)
    expect(s.calls[0]!.body).toHaveLength(500)
    expect(s.calls[1]!.body).toHaveLength(100)
    expect(batch.results).toHaveLength(600)
  })

  it("keeps the first tag's value, not only its name", async () => {
    const s = stub({ MessageID: "m" })
    await createEmail({ driver: postmark({ token: "t", fetch: s.fetch }), defaults }).send({
      ...msg,
      tags: [
        { name: "campaign", value: "welcome-2026" },
        { name: "cohort", value: "beta" },
      ],
    })
    expect(s.calls[0]!.body).toMatchObject({
      Tag: "campaign",
      Metadata: { campaign: "welcome-2026", cohort: "beta" },
    })
  })
})

describe("a driver refuses what its features say it cannot do", () => {
  it("reports UNSUPPORTED for a template on a driver without templates", async () => {
    const { error } = await createEmail({ driver: resend({ apiKey: "re_x" }), defaults }).send({
      to: "a@x.com",
      subject: "s",
      template: { alias: "welcome" },
    })
    expect(error?.code).toBe("UNSUPPORTED")
    expect(error?.message).toContain("`template`")
  })

  it("reports UNSUPPORTED for scheduledAt on a driver without scheduling", async () => {
    const { error } = await createEmail({ driver: postmark({ token: "t" }), defaults }).send({
      ...msg,
      scheduledAt: "2030-01-01T00:00:00Z",
    })
    expect(error?.code).toBe("UNSUPPORTED")
  })

  it("does not send an empty SMTP message for a template-only body", async () => {
    const driver = smtp({ host: "smtp.invalid" })
    const { error } = await createEmail({ driver, defaults }).send({
      to: "a@x.com",
      subject: "Welcome",
      template: { alias: "welcome" },
    })
    expect(error?.code).toBe("UNSUPPORTED")
  })

  it("fails only the offending message, leaving the rest of the batch alone", async () => {
    const driver = mock()
    const batch = await createEmail({ driver: { ...driver, features: {} }, defaults }).sendBatch([
      { ...msg, subject: "fine" },
      { ...msg, subject: "scheduled", scheduledAt: "2030-01-01T00:00:00Z" },
      { ...msg, subject: "also fine" },
    ])
    expect(batch.sent).toHaveLength(2)
    expect(batch.failed).toEqual([
      { index: 1, error: expect.objectContaining({ code: "UNSUPPORTED" }) },
    ])
    expect(driver.getInstance().messages.map((m) => m.subject)).toEqual(["fine", "also fine"])
  })

  it("says nothing about a driver that declares no features at all", async () => {
    const bare: EmailDriver = {
      name: "bare",
      send: () => ({ data: { id: "1", driver: "bare", at: new Date() }, error: null }),
    }
    const { error } = await createEmail({ driver: bare, defaults }).send({
      ...msg,
      scheduledAt: "2030-01-01T00:00:00Z",
    })
    expect(error).toBeNull()
  })
})

describe("composite drivers initialize each leg once", () => {
  function counting(name: string) {
    const initialize = vi.fn()
    return { driver: { ...mock(), name, initialize }, initialize }
  }

  it("fallback", async () => {
    const a = counting("a")
    const email = createEmail({ driver: fallback([a.driver, mock()]), defaults })
    for (let i = 0; i < 5; i++) await email.send(msg)
    expect(a.initialize).toHaveBeenCalledOnce()
  })

  it("round-robin", async () => {
    const a = counting("a")
    const b = counting("b")
    const email = createEmail({ driver: roundRobin([a.driver, b.driver]), defaults })
    for (let i = 0; i < 6; i++) await email.send(msg)
    expect(a.initialize).toHaveBeenCalledOnce()
    expect(b.initialize).toHaveBeenCalledOnce()
  })
})

describe("a response body that dies mid-stream", () => {
  it("is a retryable NETWORK failure, not a permanent PROVIDER one", async () => {
    const dying = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"re_'))
            controller.error(new Error("terminated"))
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const { error } = await createEmail({
      driver: resend({ apiKey: "re_x", fetch: dying }),
      defaults,
    }).send(msg)

    expect(error?.code).toBe("NETWORK")
    expect(error?.retryable).toBe(true)
  })

  it("does not throw past the driver boundary", async () => {
    const dying = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("terminated"))
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const driver = ses({
      region: "eu-central-1",
      accessKeyId: "AKIA",
      secretAccessKey: "s",
      fetch: dying,
    })
    await expect(
      driver.send(normalizeMessage({ from: "a@b.com", ...msg }), {
        driver: "ses",
        attempt: 1,
        meta: {},
      }),
    ).resolves.toMatchObject({ error: expect.objectContaining({ code: "NETWORK" }) })
  })
})
