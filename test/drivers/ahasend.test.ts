import { describe, expect, it } from "vitest"
import type { SendContext } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { normalizeMessage } from "../../src/core/message.ts"
import ahasend from "../../src/drivers/ahasend.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }
const apiKey = "aha-sk-test"
const accountId = "11111111-2222-4333-8444-555555555555"
const account = `https://api.ahasend.com/v2/accounts/${accountId}`

/** Records every request and answers with a scripted response. */
function stubFetch(
  script: (url: string, init: RequestInit) => [number, unknown, Record<string, string>?],
) {
  const calls: {
    url: string
    method: string
    headers: Record<string, string>
    signal: AbortSignal | null | undefined
    body: any
  }[] = []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const [status, payload, headers] = script(url, init)
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      signal: init.signal,
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    })
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const queued = (over: Record<string, unknown> = {}) => ({
  object: "message",
  id: "<abc-123@acme.com>",
  recipient: { email: "ada@example.com", name: "Ada" },
  status: "queued",
  error: null,
  ...over,
})

const accepted = (entries: unknown[] = [queued()]) => ({ object: "list", data: entries })

const driver = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  ahasend({ apiKey, accountId, fetch: fetchImpl, ...over })

const email = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  createEmail({ driver: driver(fetchImpl, over), defaults })

describe("ahasend", () => {
  describe("construction", () => {
    it("refuses options that cannot address the API", () => {
      expect(() => ahasend({ apiKey: "", accountId })).toThrow(/missing required option/)
      expect(() => ahasend({ apiKey, accountId: "" })).toThrow(/missing required option/)
      expect(() => ahasend({ apiKey: "sk_live_nope", accountId })).toThrow(
        /must start with 'aha-sk-'/,
      )
    })

    it("declares only what AhaSend actually does", () => {
      const features = driver(stubFetch(() => [200, null]).fetch).features
      expect(features).toEqual({
        attachments: true,
        html: true,
        text: true,
        scheduling: true,
        idempotency: true,
        tracking: true,
        tagging: true,
        replyTo: true,
        customHeaders: true,
        sandbox: true,
        cancelable: true,
        retrievable: true,
      })
      // No batch endpoint exists, so there is no `sendBatch` to mismap.
      expect(driver(stubFetch(() => [200, null]).fetch).sendBatch).toBeUndefined()
    })
  })

  describe("sending", () => {
    it("maps the message onto the account-scoped create-message payload", async () => {
      const stub = stubFetch(() => [202, accepted()])
      const { data, error } = await email(stub.fetch).send({
        ...msg,
        replyTo: "Support <support@acme.com>",
        html: "<p>hi</p>",
        tags: [{ name: "campaign", value: "welcome" }],
        metadata: { userId: "42" },
        tracking: { opens: true, clicks: false },
        scheduledAt: "2030-01-01T00:00:00Z",
      })

      expect(error).toBeNull()
      expect(data?.id).toBe("<abc-123@acme.com>")
      expect(data?.driver).toBe("ahasend")

      const [call] = stub.calls
      expect(call?.url).toBe(`${account}/messages`)
      expect(call?.method).toBe("POST")
      expect(call?.headers.authorization).toBe(`Bearer ${apiKey}`)
      expect(call?.body).toEqual({
        from: { email: "hi@acme.com", name: "Acme" },
        recipients: [{ email: "ada@example.com", name: "Ada" }],
        reply_to: { email: "support@acme.com", name: "Support" },
        subject: "hi",
        text_content: "hello",
        html_content: "<p>hi</p>",
        headers: { "X-Metadata-userId": "42", "X-Tag-campaign": "welcome" },
        tags: ["campaign"],
        tracking: { open: true, click: false },
        schedule: { first_attempt: "2030-01-01T00:00:00.000Z" },
      })
    })

    it("uses the conversation endpoint for cc and bcc, which the other has not got", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await email(stub.fetch).send({ ...msg, cc: "cc@x.com", bcc: "bcc@x.com" })

      const [call] = stub.calls
      expect(call?.url).toBe(`${account}/messages/conversation`)
      expect(call?.body).toMatchObject({
        to: [{ email: "ada@example.com", name: "Ada" }],
        cc: [{ email: "cc@x.com" }],
        bcc: [{ email: "bcc@x.com" }],
      })
      expect(call?.body.recipients).toBeUndefined()
    })

    it("uses it for several To addresses too, which the other would fan out", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await email(stub.fetch).send({ ...msg, to: ["a@x.com", "b@x.com"] })

      expect(stub.calls[0]?.url).toBe(`${account}/messages/conversation`)
      expect(stub.calls[0]?.body.to).toEqual([{ email: "a@x.com" }, { email: "b@x.com" }])
    })

    it("keeps a single recipient on the plain endpoint", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await email(stub.fetch).send(msg)
      expect(stub.calls[0]?.url).toBe(`${account}/messages`)
    })

    it("puts a second Reply-To in the header, since the field holds only one", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await email(stub.fetch).send({ ...msg, replyTo: ["a@acme.com", "Bee <b@acme.com>"] })

      const [call] = stub.calls
      expect(call?.body.reply_to).toBeUndefined()
      expect(call?.body.headers["Reply-To"]).toBe("a@acme.com, Bee <b@acme.com>")
    })

    it("refuses more recipients than the conversation endpoint accepts", async () => {
      const stub = stubFetch(() => [202, accepted()])
      const { error } = await email(stub.fetch).send({
        ...msg,
        to: Array.from({ length: 51 }, (_, i) => `a${i}@x.com`),
      })
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(error?.message).toMatch(/at most 50/)
      expect(stub.calls).toHaveLength(0)
    })

    it("base64-encodes an attachment and keeps a Content-ID in its brackets", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await email(stub.fetch).send({
        ...msg,
        attachments: [
          { filename: "a.txt", content: new TextEncoder().encode("hello") },
          {
            filename: "logo.png",
            content: "AAA",
            encoding: "base64",
            contentType: "image/png",
            cid: "logo@acme",
            disposition: "inline",
          },
        ],
      })

      expect(stub.calls[0]?.body.attachments).toEqual([
        {
          file_name: "a.txt",
          content_type: "application/octet-stream",
          base64: true,
          data: "aGVsbG8=",
        },
        {
          file_name: "logo.png",
          content_type: "image/png",
          base64: true,
          data: "AAA",
          // Without the angle brackets AhaSend delivers it as a download.
          content_id: "<logo@acme>",
          content_disposition: "inline",
        },
      ])
    })

    it("routes to the sandbox on the message or on the driver", async () => {
      const perMessage = stubFetch(() => [202, accepted()])
      await email(perMessage.fetch).send({ ...msg, sandbox: true })
      expect(perMessage.calls[0]?.body.sandbox).toBe(true)
      expect(perMessage.calls[0]?.body.sandbox_result).toBeUndefined()

      const always = stubFetch(() => [202, accepted()])
      await email(always.fetch, { sandbox: true, sandboxResult: "bounce" }).send(msg)
      expect(always.calls[0]?.body).toMatchObject({ sandbox: true, sandbox_result: "bounce" })
    })

    it("refuses a message with no subject rather than sending an empty one", async () => {
      const stub = stubFetch(() => [202, accepted()])
      const ctx: SendContext = { driver: "ahasend", attempt: 1, meta: {} }
      const templated = normalizeMessage({
        from: "hi@acme.com",
        to: "ada@example.com",
        template: { id: "welcome" },
      })

      const { error } = await driver(stub.fetch).send(templated, ctx)
      expect(error?.code).toBe("INVALID_OPTIONS")
      expect(stub.calls).toHaveLength(0)
    })

    it("declines a template, which AhaSend does not host", async () => {
      const stub = stubFetch(() => [202, accepted()])
      const { error } = await email(stub.fetch).send({ ...msg, template: { id: "welcome" } })
      expect(error?.code).toBe("UNSUPPORTED")
    })

    it("declines a remote attachment it cannot fetch", async () => {
      const stub = stubFetch(() => [202, accepted()])
      const { error } = await email(stub.fetch).send({
        ...msg,
        attachments: [{ filename: "a.pdf", url: "https://acme.com/a.pdf" }],
      })
      expect(error?.code).toBe("UNSUPPORTED")
    })
  })

  describe("idempotency", () => {
    it("carries the message's key in the header AhaSend documents", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await email(stub.fetch).send({ ...msg, idempotencyKey: "order-1:receipt" })
      expect(stub.calls[0]?.headers["idempotency-key"]).toBe("order-1:receipt")
    })

    it("sends no key when the message has none", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await email(stub.fetch).send(msg)
      expect(stub.calls[0]?.headers["idempotency-key"]).toBeUndefined()
    })

    it("reports a replayed response instead of pretending it was a fresh send", async () => {
      const replay = stubFetch(() => [202, accepted(), { "idempotent-replayed": "true" }])
      const { data } = await email(replay.fetch).send({ ...msg, idempotencyKey: "order-1" })
      expect(data?.meta?.idempotentReplayed).toBe(true)

      const fresh = stubFetch(() => [202, accepted()])
      const first = await email(fresh.fetch).send({ ...msg, idempotencyKey: "order-1" })
      expect(first.data?.meta?.idempotentReplayed).toBeUndefined()
    })

    it("treats an in-progress key as worth retrying and a reused one as not", async () => {
      const inProgress = stubFetch(() => [
        409,
        { message: "A request with this idempotency key is already in progress" },
        { "idempotent-replayed": "false", "retry-after": "2" },
      ])
      const conflict = await email(inProgress.fetch).send({ ...msg, idempotencyKey: "order-1" })
      expect(conflict.error?.status).toBe(409)
      expect(conflict.error?.retryable).toBe(true)

      const mismatch = stubFetch(() => [
        422,
        { message: "idempotency key was already used with a different request payload" },
      ])
      const reused = await email(mismatch.fetch).send({ ...msg, idempotencyKey: "order-1" })
      expect(reused.error?.status).toBe(422)
      expect(reused.error?.retryable).toBe(false)
      expect(reused.error?.message).toMatch(/different request payload/)
    })
  })

  describe("the response", () => {
    it("accepts the send when at least one recipient was queued, and keeps the rest", async () => {
      const stub = stubFetch(() => [
        202,
        accepted([
          queued({ id: null, status: "error", error: "recipient is suppressed" }),
          queued({ id: "<second@acme.com>" }),
        ]),
      ])
      const { data, error } = await email(stub.fetch).send({ ...msg, cc: "cc@x.com" })

      expect(error).toBeNull()
      expect(data?.id).toBe("<second@acme.com>")
      const provider = data?.provider as { data: { error: string | null }[] }
      expect(provider.data[0]?.error).toBe("recipient is suppressed")
    })

    it("fails with the provider's own reason when nothing was queued", async () => {
      const stub = stubFetch(() => [
        202,
        accepted([queued({ id: null, status: "error", error: "recipient is suppressed" })]),
      ])
      const { error } = await email(stub.fetch).send(msg)
      expect(error?.code).toBe("PROVIDER")
      expect(error?.message).toMatch(/recipient is suppressed/)
    })

    it("fails when the body carries no message id at all", async () => {
      const stub = stubFetch(() => [202, { object: "list" }])
      const { error } = await email(stub.fetch).send(msg)
      expect(error?.code).toBe("PROVIDER")
      expect(error?.message).toMatch(/did not contain a message id/)
    })

    it("classifies status codes into the shared taxonomy", async () => {
      const cases = [
        [401, "AUTH", false],
        [403, "AUTH", false],
        [429, "RATE_LIMIT", true],
        [500, "NETWORK", true],
        [400, "PROVIDER", false],
      ] as const
      for (const [status, code, retryable] of cases) {
        const stub = stubFetch(() => [status, { message: "nope" }])
        const { error } = await email(stub.fetch).send(msg)
        expect([status, error?.code, error?.retryable]).toEqual([status, code, retryable])
        expect(error?.message).toMatch(/nope/)
      }
    })

    it("reports a network failure as a Result rather than throwing", async () => {
      const impl = (async () => {
        throw new TypeError("fetch failed")
      }) as unknown as typeof fetch
      const { error } = await email(impl).send(msg)
      expect(error?.driver).toBe("ahasend")
      expect(error?.code).toBe("PROVIDER")
    })
  })

  describe("cancel, retrieve and liveness", () => {
    it("cancels a scheduled message with DELETE", async () => {
      const stub = stubFetch(() => [200, { message: "ok" }])
      const { error } = await email(stub.fetch).cancel("<abc-123@acme.com>")

      expect(error).toBeNull()
      expect(stub.calls[0]?.method).toBe("DELETE")
      expect(stub.calls[0]?.url).toBe(
        `${account}/messages/${encodeURIComponent("<abc-123@acme.com>")}/cancel`,
      )
    })

    it("maps AhaSend's statuses onto the shared lifecycle", async () => {
      const cases = [
        ["Received", "queued"],
        ["Deferred", "queued"],
        ["Delivered", "delivered"],
        ["Bounced", "bounced"],
        ["Failed", "failed"],
        ["Suppressed", "failed"],
        ["Sandbox Delivered", "delivered"],
        ["Something New", "unknown"],
      ] as const
      for (const [status, state] of cases) {
        const stub = stubFetch(() => [
          200,
          {
            id: "0f0f0f0f-0000-4000-8000-000000000000",
            message_id: "<abc-123@acme.com>",
            status,
            created_at: "2030-01-01T00:00:00Z",
            delivered_at: "2030-01-01T00:05:00Z",
          },
        ])
        const { data } = await email(stub.fetch).retrieve("<abc-123@acme.com>")
        expect([status, data?.state]).toEqual([status, state])
        expect(data?.id).toBe("<abc-123@acme.com>")
        expect(data?.at?.toISOString()).toBe("2030-01-01T00:05:00.000Z")
      }
    })

    it("falls back to when the message was created if it has not been delivered", async () => {
      const stub = stubFetch(() => [
        200,
        { message_id: "<abc@acme.com>", status: "Received", created_at: "2030-01-01T00:00:00Z" },
      ])
      const { data } = await email(stub.fetch).retrieve("<abc@acme.com>")
      expect(data?.at?.toISOString()).toBe("2030-01-01T00:00:00.000Z")
    })

    it("pings an account-independent route to answer whether it can send", async () => {
      const up = stubFetch(() => [200, { message: "pong" }])
      const down = stubFetch(() => [401, { message: "unauthorized" }])
      expect(await driver(up.fetch).isAvailable?.()).toBe(true)
      expect(up.calls[0]?.url).toBe("https://api.ahasend.com/v2/ping")
      expect(up.calls[0]?.method).toBe("GET")
      expect(await driver(down.fetch).isAvailable?.()).toBe(false)
    })
  })

  describe("plumbing", () => {
    it("takes a base URL override for a gateway or a stub", async () => {
      const stub = stubFetch(() => [202, accepted()])
      await createEmail({
        driver: ahasend({
          apiKey,
          accountId,
          endpoint: "https://gateway.acme.com/",
          fetch: stub.fetch,
        }),
        defaults,
      }).send(msg)
      expect(stub.calls[0]?.url).toBe(`https://gateway.acme.com/v2/accounts/${accountId}/messages`)
    })

    it("forwards the caller's abort signal to the request", async () => {
      const controller = new AbortController()
      const stub = stubFetch(() => [202, accepted()])
      await createEmail({
        driver: driver(stub.fetch),
        defaults,
        signal: controller.signal,
      }).send(msg)

      const forwarded = stub.calls[0]?.signal
      expect(forwarded).toBeInstanceOf(AbortSignal)
      expect(forwarded?.aborted).toBe(false)
      controller.abort()
      expect(forwarded?.aborted).toBe(true)
    })

    it("forwards it to retrieve and cancel as well", async () => {
      const controller = new AbortController()
      const stub = stubFetch(() => [200, { message_id: "<a@b.com>", status: "Delivered" }])
      const instance = createEmail({
        driver: driver(stub.fetch),
        defaults,
        signal: controller.signal,
      })
      await instance.retrieve("<a@b.com>")
      await instance.cancel("<a@b.com>")

      controller.abort()
      expect(stub.calls.map((c) => c.signal?.aborted)).toEqual([true, true])
    })

    it("sends a batch one request per message, in order", async () => {
      const ids = ["<a@acme.com>", "<b@acme.com>"]
      let call = 0
      const stub = stubFetch(() => [202, accepted([queued({ id: ids[call++] })])])
      const batch = await email(stub.fetch).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
      ])

      expect(batch.ok).toBe(true)
      expect(batch.results.map((r) => r.data?.id)).toEqual(ids)
      expect(stub.calls.map((c) => c.body.recipients[0].email)).toEqual(["a@x.com", "b@x.com"])
    })

    it("keeps a batch positional when one message fails", async () => {
      const stub = stubFetch((_url, init) =>
        String(init.body).includes("b@x.com")
          ? [400, { message: "unknown domain" }]
          : [202, accepted()],
      )
      const batch = await email(stub.fetch).sendBatch([
        { ...msg, to: "a@x.com" },
        { ...msg, to: "b@x.com" },
        { ...msg, to: "c@x.com" },
      ])

      expect(batch.results).toHaveLength(3)
      expect(batch.results.map((r) => r.error?.code ?? "ok")).toEqual(["ok", "PROVIDER", "ok"])
      expect(batch.failed.map((f) => f.index)).toEqual([1])
    })
  })
})
