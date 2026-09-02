import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import sendgrid from "../../src/drivers/sendgrid.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const apiKey = "SG.test"

/** Records every request and answers with a scripted response. SendGrid
 *  answers a send with 202, an empty body and the id in a header, so the
 *  script returns response headers as well as a status and a payload. */
function stub(
  script: (url: string, init: RequestInit) => [number, unknown, Record<string, string>?],
) {
  const calls: {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  }[] = []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const [status, payload, headers = {}] = script(url, init)
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    })
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

/** The ordinary answer: 202, no body, the id in `X-Message-Id`. */
const accepted = (id = "sg_1") => stub(() => [202, null, { "x-message-id": id }])

const email = (stubbed: ReturnType<typeof stub>, options = {}) =>
  createEmail({ driver: sendgrid({ apiKey, fetch: stubbed.fetch, ...options }), defaults })

describe("sendgrid", () => {
  it("rejects a key that is not a SendGrid key", () => {
    expect(() => sendgrid({ apiKey: "re_nope" })).toThrow(/must start with 'SG\.'/)
    expect(() => sendgrid({ apiKey: "" })).toThrow(/missing required option/)
  })

  it("maps the message onto the v3 payload", async () => {
    const s = accepted()
    const { data } = await email(s).send({
      ...msg,
      cc: "cc@x.com",
      bcc: "bcc@x.com",
      replyTo: "reply@acme.com",
      html: "<p>hi</p>",
      headers: { "X-Campaign": "welcome" },
      metadata: { userId: "42" },
      tags: [{ name: "campaign", value: "welcome-2026" }],
      tracking: { opens: true, clicks: false },
    })

    expect(data?.id).toBe("sg_1")
    const call = s.calls[0]!
    expect(call.url).toBe("https://api.sendgrid.com/v3/mail/send")
    expect(call.headers.authorization).toBe(`Bearer ${apiKey}`)
    expect(call.body).toMatchObject({
      from: { email: "hi@acme.com", name: "Acme" },
      subject: "hi",
      reply_to: { email: "reply@acme.com" },
      headers: { "X-Campaign": "welcome" },
      categories: ["campaign"],
      tracking_settings: {
        open_tracking: { enable: true },
        click_tracking: { enable: false, enable_text: false },
      },
      personalizations: [
        {
          to: [{ email: "ada@example.com", name: "Ada" }],
          cc: [{ email: "cc@x.com" }],
          bcc: [{ email: "bcc@x.com" }],
          subject: "hi",
          custom_args: { userId: "42", campaign: "welcome-2026" },
        },
      ],
    })
  })

  it("puts text/plain before text/html, as RFC 1341 order requires", async () => {
    const s = accepted()
    await email(s).send({ ...msg, html: "<p>hi</p>" })
    expect(s.calls[0]!.body.content).toEqual([
      { type: "text/plain", value: "hello" },
      { type: "text/html", value: "<p>hi</p>" },
    ])
  })

  it("uses reply_to_list for more than one reply-to, never both fields", async () => {
    const s = accepted()
    await email(s).send({ ...msg, replyTo: ["a@x.com", "Bee <b@x.com>"] })
    expect(s.calls[0]!.body.reply_to).toBeUndefined()
    expect(s.calls[0]!.body.reply_to_list).toEqual([
      { email: "a@x.com" },
      { email: "b@x.com", name: "Bee" },
    ])
  })

  it("reads the id off the response header, not out of the empty body", async () => {
    const s = stub(() => [202, null, { "X-Message-Id": "6T_EJ2NWQ7iEJcMJUrL0Wg" }])
    const { data } = await email(s).send(msg)
    expect(data?.id).toBe("6T_EJ2NWQ7iEJcMJUrL0Wg")
    expect(data?.provider).toMatchObject({ x_message_id: "6T_EJ2NWQ7iEJcMJUrL0Wg" })
  })

  it("fails when the response carried no id at all", async () => {
    const s = stub(() => [202, null])
    const { error } = await email(s).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toMatch(/X-Message-Id/)
  })

  it("base64-encodes attachments and makes a cid inline", async () => {
    const s = accepted()
    await email(s).send({
      ...msg,
      attachments: [
        {
          filename: "a.txt",
          content: new TextEncoder().encode("hello"),
          contentType: "text/plain",
        },
        { filename: "logo.png", content: "test", cid: "logo" },
      ],
    })
    expect(s.calls[0]!.body.attachments).toEqual([
      {
        filename: "a.txt",
        content: "aGVsbG8=",
        type: "text/plain",
        disposition: "attachment",
      },
      {
        filename: "logo.png",
        // "test" is text, not base64 that happens to look like a word.
        content: "dGVzdA==",
        type: "application/octet-stream",
        disposition: "inline",
        content_id: "logo",
      },
    ])
  })

  describe("templates", () => {
    it("sends dynamic_template_data for a d- template", async () => {
      const s = accepted()
      await email(s).send({
        ...msg,
        template: { id: "d-123", variables: { name: "Ada", count: 3 } },
      })
      expect(s.calls[0]!.body.template_id).toBe("d-123")
      expect(s.calls[0]!.body.personalizations[0].dynamic_template_data).toEqual({
        name: "Ada",
        count: 3,
      })
    })

    it("sends string substitutions for a legacy template", async () => {
      const s = accepted()
      await email(s).send({ ...msg, template: { id: "abc", variables: { count: 3 } } })
      expect(s.calls[0]!.body.personalizations[0]).toMatchObject({
        substitutions: { count: "3" },
      })
      expect(s.calls[0]!.body.personalizations[0].dynamic_template_data).toBeUndefined()
    })

    it("refuses a template named only by alias — SendGrid has no aliases", async () => {
      const s = accepted()
      const { error } = await email(s).send({ ...msg, template: { alias: "welcome" } })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/template\.id/)
      expect(s.calls).toHaveLength(0)
    })
  })

  describe("scheduling", () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000)

    it("sends send_at as unix seconds and reserves a batch id to cancel by", async () => {
      const s = stub((url) =>
        url.endsWith("/v3/mail/batch")
          ? [201, { batch_id: "BATCH1" }]
          : [202, null, { "x-message-id": "sg_1" }],
      )
      const { data } = await email(s).send({ ...msg, scheduledAt })

      expect(s.calls.map((c) => c.url)).toEqual([
        "https://api.sendgrid.com/v3/mail/batch",
        "https://api.sendgrid.com/v3/mail/send",
      ])
      const body = s.calls[1]!.body
      expect(body.batch_id).toBe("BATCH1")
      expect(body.personalizations[0].send_at).toBe(Math.floor(scheduledAt.getTime() / 1000))
      // The batch id is what `cancel()` takes, so it is the id reported.
      expect(data?.id).toBe("BATCH1")
      expect(data?.provider).toMatchObject({ x_message_id: "sg_1", batch_id: "BATCH1" })
    })

    it("skips the extra request when batch ids are turned off", async () => {
      const s = accepted()
      const { data } = await email(s, { batchIdForScheduled: false }).send({ ...msg, scheduledAt })
      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.body.batch_id).toBeUndefined()
      expect(data?.id).toBe("sg_1")
    })

    it("fails the send when the batch id cannot be reserved", async () => {
      const s = stub(() => [401, { errors: [{ message: "authorization required" }] }])
      const { error } = await email(s).send({ ...msg, scheduledAt })
      expect(error?.code).toBe("AUTH")
      expect(s.calls).toHaveLength(1)
    })

    it("refuses a send more than 72 hours out", async () => {
      const s = accepted()
      const { error } = await email(s).send({
        ...msg,
        scheduledAt: new Date(Date.now() + 73 * 60 * 60 * 1000),
      })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/72 hours/)
      expect(s.calls).toHaveLength(0)
    })
  })

  describe("sandbox mode", () => {
    it("enables it per message and per driver", async () => {
      const s = accepted()
      await email(s).send({ ...msg, sandbox: true })
      expect(s.calls[0]!.body.mail_settings).toEqual({ sandbox_mode: { enable: true } })

      const t = accepted()
      await email(t, { sandbox: true }).send(msg)
      expect(t.calls[0]!.body.mail_settings).toEqual({ sandbox_mode: { enable: true } })
    })

    it("does not fail a 200 with no id, because a sandbox send never gets one", async () => {
      const s = stub(() => [200, null])
      const { data, error } = await email(s, { sandbox: true }).send(msg)
      expect(error).toBeNull()
      expect(data?.id).toBe("sandbox")
    })
  })

  describe("limits it refuses before the request", () => {
    const cases = [
      {
        name: "more than 10 categories",
        patch: { tags: Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, value: "v" })) },
        match: /at most 10 categories/,
      },
      {
        name: "a category longer than 255 characters",
        patch: { tags: [{ name: "x".repeat(256), value: "v" }] },
        match: /longer than 255/,
      },
      {
        name: "a header SendGrid reserves",
        patch: { headers: { "Content-Type": "text/plain" } },
        match: /may not be overridden/,
      },
    ]

    for (const { name, patch, match } of cases) {
      it(`refuses ${name}`, async () => {
        const s = accepted()
        const { error } = await email(s).send({ ...msg, ...patch })
        expect(error?.code).toBe("INVALID_OPTIONS")
        expect(error?.message).toMatch(match)
        expect(s.calls).toHaveLength(0)
      })
    }

    it("deduplicates categories rather than failing the request on them", async () => {
      const s = accepted()
      await email(s).send({
        ...msg,
        tags: [
          { name: "campaign", value: "a" },
          { name: "campaign", value: "b" },
        ],
      })
      expect(s.calls[0]!.body.categories).toEqual(["campaign"])
    })
  })

  describe("driver-wide settings", () => {
    it("carries the ip pool, the unsubscribe group and the subuser header", async () => {
      const s = accepted()
      await email(s, {
        ipPoolName: "transactional",
        asm: { groupId: 42, groupsToDisplay: [42, 43] },
        onBehalfOf: "subuser",
      }).send(msg)

      expect(s.calls[0]!.headers["on-behalf-of"]).toBe("subuser")
      expect(s.calls[0]!.body).toMatchObject({
        ip_pool_name: "transactional",
        asm: { group_id: 42, groups_to_display: [42, 43] },
      })
    })

    it("honours an endpoint override, such as the EU host", async () => {
      const s = accepted()
      await email(s, { endpoint: "https://api.eu.sendgrid.com/" }).send(msg)
      expect(s.calls[0]!.url).toBe("https://api.eu.sendgrid.com/v3/mail/send")
    })
  })

  describe("batching", () => {
    it("puts messages that share an envelope in one request, positionally", async () => {
      const s = accepted("sg_batch")
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com", subject: "one" },
        { ...msg, to: "b@x.com", subject: "two" },
      ])

      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.body.personalizations).toEqual([
        { to: [{ email: "a@x.com" }], subject: "one" },
        { to: [{ email: "b@x.com" }], subject: "two" },
      ])
      // The subject is per personalization; the message-level one only has
      // to be present, so it is the first message's.
      expect(s.calls[0]!.body.subject).toBe("one")
      expect(batch.results.map((r) => r.data?.id)).toEqual(["sg_batch", "sg_batch"])
    })

    it("splits messages whose bodies differ into separate requests", async () => {
      const s = accepted()
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com", html: "<p>one</p>" },
        { ...msg, to: "b@x.com", html: "<p>two</p>" },
      ])
      expect(s.calls).toHaveLength(2)
      expect(batch.sent).toHaveLength(2)
    })

    it("chunks at the 1000-personalization cap", async () => {
      const s = accepted()
      const batch = await email(s).sendBatch(
        Array.from({ length: 1500 }, (_, i) => ({ ...msg, to: `a${i}@x.com` })),
      )
      expect(s.calls).toHaveLength(2)
      expect(s.calls[0]!.body.personalizations).toHaveLength(1000)
      expect(s.calls[1]!.body.personalizations).toHaveLength(500)
      expect(batch.results).toHaveLength(1500)
    })

    it("chunks on recipients too, which run out before personalizations do", async () => {
      const s = accepted()
      await email(s).sendBatch(
        Array.from({ length: 400 }, (_, i) => ({
          ...msg,
          to: `a${i}@x.com`,
          cc: [`b${i}@x.com`, `c${i}@x.com`],
        })),
      )
      expect(s.calls).toHaveLength(2)
      expect(s.calls[0]!.body.personalizations).toHaveLength(333)
      expect(s.calls[1]!.body.personalizations).toHaveLength(67)
    })

    it("starts a new request rather than repeating an address in one", async () => {
      const s = accepted()
      const batch = await email(s).sendBatch([
        { ...msg, to: "ada@x.com", subject: "first" },
        { ...msg, to: "ada@x.com", subject: "second" },
      ])
      expect(s.calls).toHaveLength(2)
      expect(batch.sent).toHaveLength(2)
    })

    it("fails only the message that breaks a limit", async () => {
      const s = accepted()
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com", tags: [{ name: "x".repeat(300), value: "v" }] },
        { ...msg, to: "c@x.com" },
      ])
      expect(batch.sent).toHaveLength(2)
      expect(batch.failed).toEqual([
        { index: 1, error: expect.objectContaining({ code: "INVALID_OPTIONS" }) },
      ])
      expect(s.calls[0]!.body.personalizations).toHaveLength(2)
    })

    it("reports the request's failure against every message in it", async () => {
      const s = stub(() => [500, { errors: [{ message: "internal server error" }] }])
      const batch = await email(s).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])
      expect(batch.failed.map((f) => f.index)).toEqual([0, 1])
      expect(batch.failed[0]?.error.code).toBe("NETWORK")
    })
  })

  describe("errors", () => {
    it("classifies status codes into the shared taxonomy", async () => {
      const cases = [
        [401, "AUTH", false],
        [403, "AUTH", false],
        [429, "RATE_LIMIT", true],
        [500, "NETWORK", true],
        [400, "PROVIDER", false],
        [413, "PROVIDER", false],
      ] as const
      for (const [status, code, retryable] of cases) {
        const s = stub(() => [status, { errors: [{ message: "nope" }] }])
        const { error } = await email(s).send(msg)
        expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
      }
    })

    it("reports every error in the response, with the field each names", async () => {
      const s = stub(() => [
        400,
        {
          errors: [
            { field: "personalizations.0.to", message: "invalid email" },
            { field: null, message: "subject is required" },
          ],
        },
      ])
      const { error } = await email(s).send(msg)
      expect(error?.message).toContain("personalizations.0.to: invalid email")
      expect(error?.message).toContain("subject is required")
    })
  })

  describe("scheduled sends already accepted", () => {
    it("cancels one by its batch id", async () => {
      const s = stub(() => [201, null])
      const client = email(s)
      const { error } = await client.cancel("BATCH1")
      expect(error).toBeNull()
      expect(s.calls[0]!.url).toBe("https://api.sendgrid.com/v3/user/scheduled_sends")
      expect(s.calls[0]!.body).toEqual({ batch_id: "BATCH1", status: "cancel" })
    })

    it("retrieves its state, and says nothing when there is no record", async () => {
      const cancelled = stub(() => [200, [{ batch_id: "BATCH1", status: "cancel" }]])
      expect((await email(cancelled).retrieve("BATCH1")).data?.state).toBe("cancelled")

      const paused = stub(() => [200, [{ batch_id: "BATCH1", status: "pause" }]])
      expect((await email(paused).retrieve("BATCH1")).data?.state).toBe("scheduled")

      const none = stub(() => [200, []])
      expect((await email(none).retrieve("BATCH1")).data?.state).toBe("unknown")
    })
  })

  it("cancels an in-flight request when the caller's signal aborts", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response("", { status: 202, headers: { "x-message-id": "sg_1" } })
    }) as unknown as typeof fetch

    await createEmail({
      driver: sendgrid({ apiKey, fetch: hanging }),
      defaults,
      signal: controller.signal,
    }).send(msg)

    expect(aborted).toBe(true)
  })

  it("forwards a caller-supplied timeout", async () => {
    const seen: (AbortSignal | undefined)[] = []
    const s = accepted()
    const spy = (async (url: string | URL, init: RequestInit = {}) => {
      seen.push(init.signal ?? undefined)
      return s.fetch(url, init)
    }) as unknown as typeof fetch

    await createEmail({
      driver: sendgrid({ apiKey, fetch: spy, timeoutMs: 1 }),
      defaults,
    }).send(msg)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })
})
