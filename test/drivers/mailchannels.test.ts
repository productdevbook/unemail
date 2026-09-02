import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import { normalizeMessage } from "../../src/core/message.ts"
import mailchannels from "../../src/drivers/mailchannels.ts"

const msg = { to: "Ada <ada@example.com>", subject: "s", text: "t" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const sent = { request_id: "rq_1", results: [{ index: 0, message_id: "mc_1", status: "sent" }] }

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

/** Never resolves; rejects the way `fetch` does when its signal fires. */
const hanging = (async (_url: string | URL, init: RequestInit = {}) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    )
  })) as unknown as typeof fetch

describe("mailchannels", () => {
  it("requires an api key — the free Cloudflare Workers endpoint is gone", () => {
    expect(() => mailchannels({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("is available once it has a key", async () => {
    expect(await mailchannels({ apiKey: "k" }).isAvailable?.()).toBe(true)
  })

  it("maps the message onto a personalization", async () => {
    const s = stub(sent)
    const { data } = await createEmail({
      driver: mailchannels({
        apiKey: "k",
        fetch: s.fetch,
        envelopeFrom: "bounce@acme.com",
        transactional: false,
        unsubscribeDomain: "unsub.acme.com",
      }),
      defaults,
    }).send({
      ...msg,
      html: "<p>hi</p>",
      cc: "Cee <cc@x.com>",
      bcc: "bcc@x.com",
      replyTo: "reply@acme.com",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
      tags: [
        { name: "campaign", value: "spring-2026" },
        { name: "cohort", value: "beta" },
      ],
      tracking: { opens: true, clicks: false },
    })

    expect(data?.id).toBe("mc_1")
    expect(s.calls[0]!.url).toBe("https://api.mailchannels.net/tx/v1/send")
    expect(s.calls[0]!.headers["x-api-key"]).toBe("k")
    expect(s.calls[0]!.body).toEqual({
      content: [
        { type: "text/plain", value: "t" },
        { type: "text/html", value: "<p>hi</p>" },
      ],
      campaign_id: "spring-2026",
      envelope_from: { email: "bounce@acme.com" },
      transactional: false,
      unsubscribe_settings: { custom_domain_name: "unsub.acme.com" },
      tracking_settings: {
        open_tracking: { enable: true },
        click_tracking: { enable: false },
      },
      from: { email: "hi@acme.com", name: "Acme" },
      subject: "s",
      personalizations: [
        {
          to: [{ email: "ada@example.com", name: "Ada" }],
          from: { email: "hi@acme.com", name: "Acme" },
          subject: "s",
          cc: [{ email: "cc@x.com", name: "Cee" }],
          bcc: [{ email: "bcc@x.com" }],
          reply_to: { email: "reply@acme.com" },
          headers: {
            "X-Campaign": "welcome",
            "X-Metadata-userId": "42",
            "X-Tag-cohort": "beta",
          },
        },
      ],
    })
  })

  it("puts the tracking custom domain on both settings", async () => {
    const s = stub(sent)
    await createEmail({
      driver: mailchannels({ apiKey: "k", fetch: s.fetch, trackingDomain: "links.acme.com" }),
      defaults,
    }).send({ ...msg, tracking: { opens: true, clicks: true } })

    expect(s.calls[0]!.body.tracking_settings).toEqual({
      open_tracking: { enable: true, custom_domain_name: "links.acme.com" },
      click_tracking: { enable: true, custom_domain_name: "links.acme.com" },
    })
  })

  it("base64-encodes attachments and keeps a cid as content_id", async () => {
    const s = stub(sent)
    await createEmail({ driver: mailchannels({ apiKey: "k", fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [
        { filename: "note.txt", content: "test", contentType: "text/plain" },
        { filename: "logo.png", content: new Uint8Array([1, 2, 3]), cid: "logo" },
      ],
    })

    expect(s.calls[0]!.body.attachments).toEqual([
      { filename: "note.txt", content: "dGVzdA==", type: "text/plain" },
      { filename: "logo.png", content: "AQID", content_id: "logo" },
    ])
  })

  it("signs with a per-message DKIM key on the personalization", async () => {
    const s = stub({
      request_id: "rq",
      results: [
        { index: 0, message_id: "a", status: "sent" },
        { index: 1, message_id: "b", status: "sent" },
      ],
    })
    await createEmail({
      driver: mailchannels({
        apiKey: "k",
        fetch: s.fetch,
        dkim: (m) => ({
          domain: m.from.email.split("@")[1]!,
          selector: "mc",
          privateKey: `pk-${m.from.email}`,
        }),
      }),
      defaults,
    }).sendBatch([
      { ...msg, from: "one@a.com" },
      { ...msg, from: "two@b.com" },
    ])

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.body.personalizations.map((p: any) => p.dkim_domain)).toEqual([
      "a.com",
      "b.com",
    ])
    expect(s.calls[0]!.body.personalizations[0].dkim_private_key).toBe("pk-one@a.com")
  })

  it("uses a static DKIM key when one is given directly", async () => {
    const s = stub(sent)
    await createEmail({
      driver: mailchannels({
        apiKey: "k",
        fetch: s.fetch,
        dkim: { domain: "acme.com", selector: "mc", privateKey: "PK" },
      }),
      defaults,
    }).send(msg)

    expect(s.calls[0]!.body.personalizations[0]).toMatchObject({
      dkim_domain: "acme.com",
      dkim_selector: "mc",
      dkim_private_key: "PK",
    })
  })

  describe("templates", () => {
    it("turns template variables into Mustache content plus dynamic_template_data", async () => {
      const s = stub(sent)
      await createEmail({ driver: mailchannels({ apiKey: "k", fetch: s.fetch }), defaults }).send({
        ...msg,
        html: "<p>Hi {{name}}</p>",
        template: { variables: { name: "Ada" } },
      })

      expect(s.calls[0]!.body.content).toEqual([
        { type: "text/plain", value: "t", template_type: "mustache" },
        { type: "text/html", value: "<p>Hi {{name}}</p>", template_type: "mustache" },
      ])
      expect(s.calls[0]!.body.personalizations[0].dynamic_template_data).toEqual({ name: "Ada" })
    })

    it("refuses a stored-template id, which MailChannels does not have", async () => {
      const s = stub(sent)
      const { error } = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).send({ ...msg, template: { id: "tpl_1" } })

      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/no stored templates/)
      expect(s.calls).toHaveLength(0)
    })
  })

  describe("batching", () => {
    it("puts messages sharing a body into one request as personalizations", async () => {
      const s = stub({
        request_id: "rq",
        results: [
          { index: 0, message_id: "a", status: "sent" },
          { index: 1, message_id: "b", status: "sent" },
        ],
      })
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])

      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.body.personalizations.map((p: any) => p.to[0].email)).toEqual([
        "a@x.com",
        "b@x.com",
      ])
      expect(batch.sent.map((r) => r.id)).toEqual(["a", "b"])
    })

    it("reads each outcome by its own index, not its position", async () => {
      const s = stub({
        request_id: "rq",
        results: [
          { index: 1, message_id: "b", status: "sent" },
          { index: 0, message_id: "a", status: "sent" },
        ],
      })
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])
      expect(batch.results.map((r) => r.data?.id)).toEqual(["a", "b"])
    })

    it("fails only the personalization MailChannels rejected", async () => {
      const s = stub({
        request_id: "rq",
        results: [
          { index: 0, message_id: "a", status: "sent" },
          { index: 1, status: "failed", reason: "recipient rejected" },
        ],
      })
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])

      expect(batch.sent.map((r) => r.id)).toEqual(["a"])
      expect(batch.failed[0]?.index).toBe(1)
      expect(batch.failed[0]?.error.message).toContain("recipient rejected")
      expect(batch.failed[0]?.error.retryable).toBe(false)
    })

    it("reports a personalization with no outcome rather than borrowing a neighbour's id", async () => {
      const s = stub({ request_id: "rq", results: [{ index: 0, message_id: "a", status: "sent" }] })
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])

      expect(batch.failed[0]?.index).toBe(1)
      expect(batch.failed[0]?.error.message).toMatch(/no result for message/)
    })

    it("splits messages with different bodies into separate requests, keeping order", async () => {
      const s = stub(sent)
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, text: "one" },
        { ...msg, text: "two" },
      ])

      expect(s.calls).toHaveLength(2)
      expect(s.calls.map((c) => c.body.content[0].value)).toEqual(["one", "two"])
      expect(batch.results).toHaveLength(2)
      expect(batch.ok).toBe(true)
    })

    it("chunks at the provider's 1000-personalization cap", async () => {
      const s = stub({
        request_id: "rq",
        results: Array.from({ length: 1000 }, (_, i) => ({
          index: i,
          message_id: `m${i}`,
          status: "sent",
        })),
      })
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch(Array.from({ length: 1500 }, () => msg))

      expect(s.calls).toHaveLength(2)
      expect(s.calls[0]!.body.personalizations).toHaveLength(1000)
      expect(s.calls[1]!.body.personalizations).toHaveLength(500)
      expect(batch.results).toHaveLength(1500)
    })
  })

  describe("dry run", () => {
    it("routes a sandbox message to ?dry-run=true and reports the rendered message", async () => {
      const s = stub({ data: ["From: hi@acme.com\r\nSubject: s"] })
      const { data, error } = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).send({ ...msg, sandbox: true })

      expect(error).toBeNull()
      expect(s.calls[0]!.url).toBe("https://api.mailchannels.net/tx/v1/send?dry-run=true")
      expect(data?.id).toBe("dry-run")
      expect(data?.provider).toEqual({ data: "From: hi@acme.com\r\nSubject: s" })
    })

    it("keeps dry runs and real sends in separate requests", async () => {
      const s = stub({ request_id: "rq", results: [{ index: 0, message_id: "a", status: "sent" }] })
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([msg, { ...msg, sandbox: true }])

      expect(s.calls.map((c) => c.url)).toEqual([
        "https://api.mailchannels.net/tx/v1/send",
        "https://api.mailchannels.net/tx/v1/send?dry-run=true",
      ])
      expect(batch.results).toHaveLength(2)
    })
  })

  it("queues on send-async and reports the request id and queue time", async () => {
    const s = stub({ request_id: "rq_9", queued_at: "2030-01-01T00:00:00.000Z" }, 202)
    const { data } = await createEmail({
      driver: mailchannels({ apiKey: "k", fetch: s.fetch, async: true }),
      defaults,
    }).send(msg)

    expect(s.calls[0]!.url).toBe("https://api.mailchannels.net/tx/v1/send-async")
    expect(data?.id).toBe("rq_9")
    expect(data?.at.toISOString()).toBe("2030-01-01T00:00:00.000Z")
  })

  describe("error classification", () => {
    const cases = [
      [400, "INVALID_OPTIONS", false],
      [403, "AUTH", false],
      [413, "INVALID_OPTIONS", false],
      [429, "RATE_LIMIT", true],
      [500, "NETWORK", true],
      [502, "NETWORK", true],
    ] as const

    it("maps the statuses MailChannels documents", async () => {
      for (const [status, expected, retryable] of cases) {
        const s = stub({ errors: ["something went wrong"] }, status)
        const { error } = await createEmail({
          driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
          defaults,
        }).send(msg)
        expect([status, error?.code, error?.retryable]).toEqual([status, expected, retryable])
        expect(error?.message).toContain("something went wrong")
      }
    })

    it("joins every entry of the errors array", async () => {
      const s = stub({ errors: ["bad from", "bad to"] }, 400)
      const { error } = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(error?.message).toContain("bad from; bad to")
    })

    it("reports a 202 with no message_id rather than an empty id", async () => {
      const s = stub({ request_id: "rq", results: [{ index: 0, status: "sent" }] }, 202)
      const { error } = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(error?.code).toBe("PROVIDER")
      expect(error?.message).toMatch(/message_id/)
    })
  })

  describe("limits enforced before the request", () => {
    it("rejects a campaign id that is too long at construction", () => {
      expect(() => mailchannels({ apiKey: "k", campaignId: "x".repeat(49) })).toThrow(/48/)
      expect(() => mailchannels({ apiKey: "k", campaignId: "has space" })).toThrow(/no spaces/)
    })

    it("rejects a campaign tag that is too long, without a round trip", async () => {
      const s = stub(sent)
      const { error } = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).send({ ...msg, tags: [{ name: "campaign", value: "x".repeat(49) }] })

      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(s.calls).toHaveLength(0)
    })

    it("refuses more than 1000 recipients on one message", async () => {
      const s = stub(sent)
      const { error } = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).send({ ...msg, to: Array.from({ length: 1001 }, (_, i) => `a${i}@x.com`) })

      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/1001 recipients/)
      expect(s.calls).toHaveLength(0)
    })

    it("fails only the offending message in a batch", async () => {
      const s = stub({
        request_id: "rq",
        results: [
          { index: 0, message_id: "a", status: "sent" },
          { index: 1, message_id: "c", status: "sent" },
        ],
      })
      const batch = await createEmail({
        driver: mailchannels({ apiKey: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com", template: { id: "tpl" } },
        { ...msg, to: "c@x.com" },
      ])

      expect(batch.failed.map((f) => f.index)).toEqual([1])
      expect(batch.sent.map((r) => r.id)).toEqual(["a", "c"])
    })
  })

  it("forwards ctx.signal, so an abort cancels the in-flight request", async () => {
    const driver = mailchannels({ apiKey: "k", fetch: hanging })
    const controller = new AbortController()
    const promise = driver.send(normalizeMessage({ ...msg, from: "hi@acme.com" }), {
      driver: "mailchannels",
      attempt: 1,
      meta: {},
      signal: controller.signal,
    })
    controller.abort()

    const { error } = await promise
    expect(error?.code).toBe("CANCELLED")
  })

  it("declines scheduling, which MailChannels does not offer", async () => {
    const { error } = await createEmail({ driver: mailchannels({ apiKey: "k" }), defaults }).send({
      ...msg,
      scheduledAt: "2030-01-01T00:00:00Z",
    })
    expect(error?.code).toBe("UNSUPPORTED")
  })
})
