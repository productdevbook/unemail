import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import { normalizeMessage } from "../../src/core/message.ts"
import zeptomail from "../../src/drivers/zeptomail.ts"

const msg = { to: "Ada <ada@example.com>", subject: "s", text: "t" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const accepted = {
  data: [{ code: "EM_104", message: "Email request received" }],
  request_id: "rq_1",
}

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

describe("zeptomail", () => {
  it("requires a token", () => {
    expect(() => zeptomail({ token: "" })).toThrow(/missing required option/)
  })

  it("is available once it has a token", async () => {
    expect(await zeptomail({ token: "k" }).isAvailable?.()).toBe(true)
  })

  it("adds the Zoho-enczapikey prefix, and tolerates one already there", async () => {
    const bare = stub(accepted)
    await createEmail({ driver: zeptomail({ token: "abc", fetch: bare.fetch }), defaults }).send(
      msg,
    )
    expect(bare.calls[0]!.headers.authorization).toBe("Zoho-enczapikey abc")

    const prefixed = stub(accepted)
    await createEmail({
      driver: zeptomail({ token: "Zoho-enczapikey abc", fetch: prefixed.fetch }),
      defaults,
    }).send(msg)
    expect(prefixed.calls[0]!.headers.authorization).toBe("Zoho-enczapikey abc")
  })

  it("maps the message onto ZeptoMail's payload", async () => {
    const s = stub(accepted)
    const { data } = await createEmail({
      driver: zeptomail({
        token: "k",
        fetch: s.fetch,
        bounceAddress: "bounce@acme.com",
        clientReference: "instance-default",
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
      tags: [{ name: "cohort", value: "beta" }],
      tracking: { opens: true, clicks: false },
    })

    expect(data?.id).toBe("rq_1")
    expect(s.calls[0]!.url).toBe("https://api.zeptomail.com/v1.1/email")
    expect(s.calls[0]!.body).toEqual({
      from: { address: "hi@acme.com", name: "Acme" },
      subject: "s",
      reply_to: [{ address: "reply@acme.com" }],
      textbody: "t",
      htmlbody: "<p>hi</p>",
      mime_headers: {
        "X-Campaign": "welcome",
        "X-Metadata-userId": "42",
        "X-Tag-cohort": "beta",
      },
      client_reference: "instance-default",
      bounce_address: "bounce@acme.com",
      track_clicks: false,
      track_opens: true,
      to: [{ email_address: { address: "ada@example.com", name: "Ada" } }],
      cc: [{ email_address: { address: "cc@x.com", name: "Cee" } }],
      bcc: [{ email_address: { address: "bcc@x.com" } }],
    })
  })

  it("lets a client_reference tag override the instance default, and keeps it out of the headers", async () => {
    const s = stub(accepted)
    await createEmail({
      driver: zeptomail({ token: "k", fetch: s.fetch, clientReference: "instance" }),
      defaults,
    }).send({ ...msg, tags: [{ name: "client_reference", value: "order-9" }] })

    expect(s.calls[0]!.body.client_reference).toBe("order-9")
    expect(s.calls[0]!.body.mime_headers).toBeUndefined()
  })

  it("falls back to the instance tracking defaults", async () => {
    const s = stub(accepted)
    await createEmail({
      driver: zeptomail({ token: "k", fetch: s.fetch, trackOpens: true, trackClicks: true }),
      defaults,
    }).send({ ...msg, tracking: { clicks: false } })
    expect(s.calls[0]!.body).toMatchObject({ track_opens: true, track_clicks: false })
  })

  it("base64-encodes attachments and splits cid parts into inline_images", async () => {
    const s = stub(accepted)
    await createEmail({ driver: zeptomail({ token: "k", fetch: s.fetch }), defaults }).send({
      ...msg,
      attachments: [
        { filename: "note.txt", content: "test", contentType: "text/plain" },
        {
          filename: "logo.png",
          content: new Uint8Array([1, 2, 3]),
          contentType: "image/png",
          cid: "logo",
        },
      ],
    })

    expect(s.calls[0]!.body.attachments).toEqual([
      { name: "note.txt", content: "dGVzdA==", mime_type: "text/plain" },
    ])
    expect(s.calls[0]!.body.inline_images).toEqual([
      { cid: "logo", content: "AQID", mime_type: "image/png" },
    ])
  })

  it("routes a keyed template to the template endpoint and carries merge_info", async () => {
    const s = stub(accepted)
    await createEmail({ driver: zeptomail({ token: "k", fetch: s.fetch }), defaults }).send({
      ...msg,
      template: { id: "tpl_key", variables: { name: "Ada" } },
    })

    expect(s.calls[0]!.url).toBe("https://api.zeptomail.com/v1.1/email/template")
    expect(s.calls[0]!.body).toMatchObject({
      template_key: "tpl_key",
      merge_info: { name: "Ada" },
    })
  })

  it("addresses a template by alias where one is given", async () => {
    const s = stub(accepted)
    await createEmail({ driver: zeptomail({ token: "k", fetch: s.fetch }), defaults }).send({
      ...msg,
      template: { alias: "welcome" },
    })
    expect(s.calls[0]!.body.template_alias).toBe("welcome")
  })

  it("keeps merge_info without a template, which is how the batch endpoint fills placeholders", async () => {
    const s = stub(accepted)
    await createEmail({ driver: zeptomail({ token: "k", fetch: s.fetch }), defaults }).send({
      ...msg,
      html: "<p>Hi {{name}}</p>",
      template: { variables: { name: "Ada" } },
    })
    expect(s.calls[0]!.url).toBe("https://api.zeptomail.com/v1.1/email")
    expect(s.calls[0]!.body.merge_info).toEqual({ name: "Ada" })
  })

  describe("batching", () => {
    it("puts messages that differ only by recipient into one batch request", async () => {
      const s = stub(accepted)
      const batch = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com", template: { variables: { name: "A" } } },
        { ...msg, to: "b@x.com", template: { variables: { name: "B" } } },
      ])

      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.url).toBe("https://api.zeptomail.com/v1.1/email/batch")
      expect(s.calls[0]!.body.to).toEqual([
        { email_address: { address: "a@x.com" }, merge_info: { name: "A" } },
        { email_address: { address: "b@x.com" }, merge_info: { name: "B" } },
      ])
      // ZeptoMail answers a batch once, so every message in it carries the
      // request's own id.
      expect(batch.results.map((r) => r.data?.id)).toEqual(["rq_1", "rq_1"])
    })

    it("uses the templated batch endpoint when the messages name a template", async () => {
      const s = stub(accepted)
      await createEmail({ driver: zeptomail({ token: "k", fetch: s.fetch }), defaults }).sendBatch([
        { ...msg, to: "a@x.com", template: { id: "tpl", variables: { n: 1 } } },
        { ...msg, to: "b@x.com", template: { id: "tpl", variables: { n: 2 } } },
      ])
      expect(s.calls[0]!.url).toBe("https://api.zeptomail.com/v1.1/email/template/batch")
      expect(s.calls[0]!.body.template_key).toBe("tpl")
    })

    it("sends messages with different bodies separately, in order", async () => {
      const s = stub(accepted)
      const batch = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, subject: "one" },
        { ...msg, subject: "two" },
      ])

      expect(s.calls.map((c) => c.url)).toEqual([
        "https://api.zeptomail.com/v1.1/email",
        "https://api.zeptomail.com/v1.1/email",
      ])
      expect(s.calls.map((c) => c.body.subject)).toEqual(["one", "two"])
      expect(batch.results).toHaveLength(2)
      expect(batch.ok).toBe(true)
    })

    it("keeps a message with cc off the batch endpoint, which would copy it to everyone", async () => {
      const s = stub(accepted)
      await createEmail({ driver: zeptomail({ token: "k", fetch: s.fetch }), defaults }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com", cc: "watcher@x.com" },
        { ...msg, to: "c@x.com" },
      ])

      const urls = s.calls.map((c) => c.url)
      expect(urls.filter((u) => u.endsWith("/email"))).toHaveLength(1)
      expect(urls.filter((u) => u.endsWith("/email/batch"))).toHaveLength(1)
      const batched = s.calls.find((c) => c.url.endsWith("/email/batch"))!
      expect(batched.body.to).toHaveLength(2)
    })

    it("chunks at the provider's 500-address cap, counting addresses not messages", async () => {
      const s = stub(accepted)
      const batch = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch(Array.from({ length: 600 }, () => ({ ...msg, to: "a@x.com" })))

      expect(s.calls).toHaveLength(2)
      expect(s.calls[0]!.body.to).toHaveLength(500)
      expect(s.calls[1]!.body.to).toHaveLength(100)
      expect(batch.results).toHaveLength(600)
    })

    it("counts every recipient of a multi-recipient message towards the cap", async () => {
      const s = stub(accepted)
      await createEmail({ driver: zeptomail({ token: "k", fetch: s.fetch }), defaults }).sendBatch(
        Array.from({ length: 300 }, () => ({ ...msg, to: ["a@x.com", "b@x.com"] })),
      )

      expect(s.calls).toHaveLength(2)
      expect(s.calls[0]!.body.to).toHaveLength(500)
      expect(s.calls[1]!.body.to).toHaveLength(100)
    })

    it("reports a failed batch against every message in it, and only those", async () => {
      const s = stub(
        { error: { code: "TM_4001", message: "bad", details: [{ code: "SM_111" }] } },
        400,
      )
      const batch = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])

      expect(batch.failed.map((f) => f.index)).toEqual([0, 1])
      expect(batch.failed[0]?.error.code).toBe("AUTH")
    })
  })

  describe("error classification", () => {
    const cases = [
      ["SERR_157", "TM_4001", 400, "AUTH", false],
      ["SM_111", "TM_4001", 400, "AUTH", false],
      ["AE_101", "TM_3601", 400, "AUTH", false],
      ["SM_133", "TM_3601", 400, "RATE_LIMIT", true],
      ["SMI_115", "TM_3601", 400, "RATE_LIMIT", true],
      ["LE_102", "TM_5001", 500, "PROVIDER", false],
      ["SM_129", "TM_8001", 400, "INVALID_OPTIONS", false],
      ["GE_102", "TM_3201", 400, "INVALID_OPTIONS", false],
      ["SM_101", "TM_3301", 400, "INVALID_OPTIONS", false],
    ] as const

    it("reads error.details[].code, which says more than the status does", async () => {
      for (const [detail, code, status, expected, retryable] of cases) {
        const s = stub(
          {
            error: {
              code,
              message: "Request failed",
              details: [{ code: detail, message: "sub reason", target: "from" }],
            },
          },
          status,
        )
        const { error } = await createEmail({
          driver: zeptomail({ token: "k", fetch: s.fetch }),
          defaults,
        }).send(msg)
        expect([detail, error?.code, error?.retryable]).toEqual([detail, expected, retryable])
        expect(error?.message).toContain("Request failed: sub reason: from")
      }
    })

    it("falls back to the status for an error code it does not know", async () => {
      const s = stub(
        { error: { code: "TM_9999", message: "new failure", details: [{ code: "XX_1" }] } },
        503,
      )
      const { error } = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(error?.code).toBe("NETWORK")
      expect(error?.message).toContain("new failure")
    })

    it("falls back to the status for an unknown shape", async () => {
      const s = stub({ nothing: true }, 401)
      const { error } = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(error?.code).toBe("AUTH")
    })

    it("reports a response with no request_id rather than inventing an id", async () => {
      const s = stub({ data: [{ code: "EM_104" }], message: "OK" })
      const { error } = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).send(msg)
      expect(error?.code).toBe("PROVIDER")
      expect(error?.message).toMatch(/request_id/)
    })
  })

  describe("limits enforced before the request", () => {
    it("refuses more than 500 addresses in a field", async () => {
      const s = stub(accepted)
      const { error } = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).send({ ...msg, to: Array.from({ length: 501 }, (_, i) => `a${i}@x.com`) })

      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/`to` has 501 addresses/)
      expect(s.calls).toHaveLength(0)
    })

    it("refuses more than 60 attachments", async () => {
      const s = stub(accepted)
      const { error } = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).send({
        ...msg,
        attachments: Array.from({ length: 61 }, (_, i) => ({ filename: `f${i}`, content: "x" })),
      })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(s.calls).toHaveLength(0)
    })

    it("refuses a subject over 500 characters", async () => {
      const s = stub(accepted)
      const { error } = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).send({ ...msg, subject: "x".repeat(501) })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(s.calls).toHaveLength(0)
    })

    it("fails only the offending message in a batch", async () => {
      const s = stub(accepted)
      const batch = await createEmail({
        driver: zeptomail({ token: "k", fetch: s.fetch }),
        defaults,
      }).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com", subject: "x".repeat(501) },
        { ...msg, to: "c@x.com" },
      ])

      expect(batch.failed.map((f) => f.index)).toEqual([1])
      expect(batch.sent).toHaveLength(2)
    })
  })

  it("forwards ctx.signal, so an abort cancels the in-flight request", async () => {
    const driver = zeptomail({ token: "k", fetch: hanging })
    const controller = new AbortController()
    const promise = driver.send(normalizeMessage({ ...msg, from: "hi@acme.com" }), {
      driver: "zeptomail",
      attempt: 1,
      meta: {},
      signal: controller.signal,
    })
    controller.abort()

    const { error } = await promise
    expect(error?.code).toBe("CANCELLED")
  })

  it("declines scheduling, which ZeptoMail does not offer", async () => {
    const { error } = await createEmail({ driver: zeptomail({ token: "k" }), defaults }).send({
      ...msg,
      scheduledAt: "2030-01-01T00:00:00Z",
    })
    expect(error?.code).toBe("UNSUPPORTED")
  })

  it("declines a sandbox message, which ZeptoMail does not offer", async () => {
    const { error } = await createEmail({ driver: zeptomail({ token: "k" }), defaults }).send({
      ...msg,
      sandbox: true,
    })
    expect(error?.code).toBe("UNSUPPORTED")
  })
})
