import { afterEach, describe, expect, it } from "vitest"
import type { FakeServerHandle, ScriptLine } from "./_smtp/fake-server.ts"
import { startFakeServer } from "./_smtp/fake-server.ts"
import { createEmail } from "../../src/core/email.ts"
import mailcrab from "../../src/drivers/mailcrab.ts"

const msg = { to: "Ada <ada@example.com>", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <dev@acme.com>" }

let server: FakeServerHandle | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

/** The happy path: greeting, EHLO, MAIL/RCPT/DATA, QUIT. */
function happyPath(): ScriptLine[] {
  return [
    { reply: "220 mailcrab ESMTP" },
    { expect: /^EHLO/i, reply: ["250-mailcrab", "250 SIZE 10240000"] },
    { expect: /^MAIL FROM/i, reply: "250 Ok" },
    { expect: /^RCPT TO/i, reply: "250 Ok" },
    { expect: /^DATA/i, reply: "354 go" },
    { expect: /^\.$/, reply: "250 queued" },
    { expect: /^QUIT/i, reply: "221 bye" },
  ]
}

/** Records every request and answers with a scripted response. */
function stubFetch(script: (url: string, init: RequestInit) => [number, unknown]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
    []
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const [status, payload] = script(url, init)
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    })
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const summary = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  from: { name: "Acme", email: "dev@acme.com" },
  to: [{ name: "Ada", email: "ada@example.com" }],
  subject: "hi",
  time: 1_700_000_000,
  date: "2023-11-14 22:13:20",
  size: "1.2 kB",
  opened: false,
  has_html: false,
  has_plain: true,
  attachments: [],
  envelope_from: "dev@acme.com",
  envelope_recipients: ["ada@example.com"],
  ...over,
})

const full = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  headers: { "Message-ID": "<abc@acme.com>", Subject: "hi" },
  text: "hello",
  html: "",
  ...over,
})

describe("mailcrab", () => {
  describe("sending", () => {
    it("delivers over SMTP and reports itself as the driver", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailcrab({ host: server.host, port: server.port }),
        defaults,
      })
      const { data, error } = await email.send(msg)

      expect(error).toBeNull()
      expect(data?.driver).toBe("mailcrab")
      expect(data?.id).toMatch(/^<.+>$/)

      const transcript = server.received.join("\n")
      expect(transcript).toContain("MAIL FROM:<dev@acme.com>")
      expect(transcript).toContain("RCPT TO:<ada@example.com>")
      expect(transcript).toContain("Subject: hi")
      // Mailcrab needs no credentials out of the box, so none are offered.
      expect(transcript).not.toContain("AUTH")
      await email.dispose()
    })

    it("puts an attachment on the wire base64-encoded", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailcrab({ host: server.host, port: server.port }),
        defaults,
      })
      await email.send({
        ...msg,
        attachments: [{ filename: "note.txt", content: "test", contentType: "text/plain" }],
      })

      const transcript = server.received.join("\n")
      expect(transcript).toContain('filename="note.txt"')
      expect(transcript).toContain("Content-Transfer-Encoding: base64")
      expect(transcript).toContain("dGVzdA==")
      await email.dispose()
    })

    it("accepts a sandbox message, because nothing it takes is ever delivered", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailcrab({ host: server.host, port: server.port }),
        defaults,
      })
      const { error } = await email.send({ ...msg, sandbox: true })
      expect(error).toBeNull()
      await email.dispose()
    })

    it("returns an SMTP refusal as a Result rather than throwing", async () => {
      server = await startFakeServer([
        { reply: "220 mailcrab ESMTP" },
        { expect: /^EHLO/i, reply: "250 mailcrab" },
        { expect: /^MAIL FROM/i, reply: "550 no" },
      ])
      const email = createEmail({
        driver: mailcrab({ host: server.host, port: server.port }),
        defaults,
      })
      const { error } = await email.send(msg)
      expect(error).toBeTruthy()
      expect(error?.driver).toBe("smtp")
      await email.dispose()
    })

    it("declines scheduling, which a catcher cannot honour", async () => {
      const { error } = await createEmail({ driver: mailcrab(), defaults }).send({
        ...msg,
        scheduledAt: "2030-01-01T00:00:00Z",
      })
      expect(error?.code).toBe("UNSUPPORTED")
    })
  })

  describe("the inbox", () => {
    it("reads Mailcrab's default HTTP port", async () => {
      const s = stubFetch(() => [200, []])
      await mailcrab({ fetch: s.fetch }).getInstance().list()
      expect(s.calls[0]!.url).toBe("http://localhost:1080/api/messages")
    })

    it("moves every route under MAILCRAB_PREFIX", async () => {
      const s = stubFetch(() => [200, []])
      await mailcrab({ fetch: s.fetch, prefix: "emails" }).getInstance().list()
      expect(s.calls[0]!.url).toBe("http://localhost:1080/emails/api/messages")
    })

    it("takes a full base URL when one is given", async () => {
      const s = stubFetch(() => [200, []])
      await mailcrab({ fetch: s.fetch, httpEndpoint: "https://crab.internal/" })
        .getInstance()
        .list()
      expect(s.calls[0]!.url).toBe("https://crab.internal/api/messages")
    })

    it("lists newest first, whatever order Mailcrab answered in", async () => {
      const s = stubFetch(() => [
        200,
        [summary({ id: "old", time: 1 }), summary({ id: "new", time: 9 })],
      ])
      const { data } = await mailcrab({ fetch: s.fetch }).getInstance().list()
      expect(data?.map((m) => m.id)).toEqual(["new", "old"])
    })

    it("fetches one message by id", async () => {
      const s = stubFetch(() => [200, full()])
      const { data } = await mailcrab({ fetch: s.fetch }).getInstance().get("abc")
      expect(s.calls[0]!.url).toBe("http://localhost:1080/api/message/abc")
      expect(data?.text).toBe("hello")
    })

    it("finds a Cc recipient on the envelope, the only place Mailcrab keeps one", async () => {
      const s = stubFetch(() => [
        200,
        [
          summary({ id: "a", envelope_recipients: ["ada@example.com", "watcher@x.com"] }),
          summary({
            id: "b",
            to: [{ email: "other@x.com" }],
            envelope_recipients: ["other@x.com"],
          }),
        ],
      ])
      const inbox = mailcrab({ fetch: s.fetch }).getInstance()

      expect((await inbox.find("WATCHER@x.com")).data?.map((m) => m.id)).toEqual(["a"])
      expect((await inbox.find("other@x.com")).data?.map((m) => m.id)).toEqual(["b"])
      expect((await inbox.find("nobody@x.com")).data).toEqual([])
    })

    it("returns the newest message in full", async () => {
      const s = stubFetch((url) =>
        url.endsWith("/api/messages")
          ? [200, [summary({ id: "old", time: 1 }), summary({ id: "new", time: 9 })]]
          : [200, full({ id: "new", text: "newest" })],
      )
      const { data } = await mailcrab({ fetch: s.fetch }).getInstance().last()
      expect(s.calls[1]!.url).toBe("http://localhost:1080/api/message/new")
      expect(data?.text).toBe("newest")
    })

    it("says so plainly when the inbox is empty", async () => {
      const s = stubFetch(() => [200, []])
      const { data, error } = await mailcrab({ fetch: s.fetch }).getInstance().last()
      expect(error).toBeNull()
      expect(data).toBeNull()
    })

    it("deletes one message and the whole inbox by POST", async () => {
      const s = stubFetch(() => [200, null])
      const inbox = mailcrab({ fetch: s.fetch }).getInstance()
      await inbox.delete("abc")
      await inbox.clear()

      expect(s.calls.map((c) => [c.method, c.url])).toEqual([
        ["POST", "http://localhost:1080/api/delete/abc"],
        ["POST", "http://localhost:1080/api/delete-all"],
      ])
    })

    it("reads the backend version", async () => {
      const s = stubFetch(() => [200, { version_be: "1.6.0" }])
      const { data } = await mailcrab({ fetch: s.fetch }).getInstance().version()
      expect(data).toBe("1.6.0")
    })

    it("turns an HTTP failure into a Result", async () => {
      const s = stubFetch(() => [500, { message: "down" }])
      const { error } = await mailcrab({ fetch: s.fetch }).getInstance().list()
      expect(error?.code).toBe("NETWORK")
      expect(error?.driver).toBe("mailcrab")
    })
  })

  describe("availability and retrieval", () => {
    it("is available when the HTTP API answers, and not when it does not", async () => {
      const up = stubFetch(() => [200, { version_be: "1.6.0" }])
      const down = stubFetch(() => [502, null])
      expect(await mailcrab({ fetch: up.fetch }).isAvailable?.()).toBe(true)
      expect(await mailcrab({ fetch: down.fetch }).isAvailable?.()).toBe(false)
    })

    it("retrieves a message by Mailcrab's own uuid without listing first", async () => {
      const id = "11111111-1111-4111-8111-111111111111"
      const s = stubFetch(() => [200, full({ id })])
      const { data } = await createEmail({
        driver: mailcrab({ fetch: s.fetch }),
        defaults,
      }).retrieve(id)

      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.url).toBe(`http://localhost:1080/api/message/${id}`)
      expect(data?.state).toBe("delivered")
      expect(data?.at?.toISOString()).toBe("2023-11-14T22:13:20.000Z")
    })

    it("finds the message a send returned, by the Message-ID in its headers", async () => {
      server = await startFakeServer(happyPath())
      let messageId = ""
      const s = stubFetch((url) => {
        if (url.endsWith("/api/messages")) return [200, [summary({ id: "other" }), summary()]]
        if (url.endsWith("/api/message/other")) {
          return [200, full({ id: "other", headers: { "Message-ID": "<someone-else@x>" } })]
        }
        return [200, full({ headers: { "Message-ID": messageId } })]
      })

      const email = createEmail({
        driver: mailcrab({ host: server.host, port: server.port, fetch: s.fetch }),
        defaults,
      })
      const { data: sent } = await email.send(msg)
      messageId = sent!.id

      const { data } = await email.retrieve(sent!.id)
      expect(data?.id).toBe("11111111-1111-4111-8111-111111111111")
      expect(data?.state).toBe("delivered")
      await email.dispose()
    })

    it("surfaces a failure met part-way through the Message-ID scan", async () => {
      const s = stubFetch((url) =>
        url.endsWith("/api/messages") ? [200, [summary()]] : [503, { message: "gone" }],
      )
      const { error } = await createEmail({
        driver: mailcrab({ fetch: s.fetch }),
        defaults,
      }).retrieve("<anything@acme.com>")
      expect(error?.code).toBe("NETWORK")
    })

    it("reports a Message-ID it cannot find rather than an empty status", async () => {
      const s = stubFetch((url) =>
        url.endsWith("/api/messages")
          ? [200, [summary()]]
          : [200, full({ headers: { "Message-ID": "<elsewhere@x>" } })],
      )
      const { error } = await createEmail({
        driver: mailcrab({ fetch: s.fetch }),
        defaults,
      }).retrieve("<missing@acme.com>")

      expect(error?.code).toBe("PROVIDER")
      expect(error?.message).toMatch(/<missing@acme.com>/)
    })
  })
})

describe("reading what JSON could not carry", () => {
  it("returns the raw RFC 5322 document as text", async () => {
    const raw = "From: a@b.com\r\nSubject: hi\r\n\r\nbody"
    const calls: string[] = []
    const stub = (async (url: string | URL) => {
      calls.push(String(url))
      return new Response(raw, { headers: { "content-type": "text/plain" } })
    }) as unknown as typeof fetch

    const inbox = mailcrab({ fetch: stub }).getInstance()
    const result = await inbox.raw("abc")

    expect(result.data).toBe(raw)
    expect(calls[0]).toBe("http://localhost:1080/api/message/abc/raw")
  })

  it("returns an attachment's bytes", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const calls: string[] = []
    const stub = (async (url: string | URL) => {
      calls.push(String(url))
      return new Response(png)
    }) as unknown as typeof fetch

    const inbox = mailcrab({ fetch: stub }).getInstance()
    const result = await inbox.attachment("abc", 1)

    expect([...(result.data ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(calls[0]).toBe("http://localhost:1080/api/message/abc/attachment/1")
  })

  it("reports a missing message as a Result, not a throw", async () => {
    const stub = (async () =>
      new Response("message not found", { status: 404 })) as unknown as typeof fetch
    const inbox = mailcrab({ fetch: stub }).getInstance()
    const result = await inbox.raw("nope")
    expect(result.data).toBeNull()
    expect(result.error?.message).toContain("message not found")
  })
})
