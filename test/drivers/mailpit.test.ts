import { afterEach, describe, expect, it } from "vitest"
import type { FakeServerHandle, ScriptLine } from "./_smtp/fake-server.ts"
import { startFakeServer } from "./_smtp/fake-server.ts"
import { createEmail } from "../../src/core/email.ts"
import mailpit from "../../src/drivers/mailpit.ts"

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
    { reply: "220 mailpit ESMTP" },
    { expect: /^EHLO/i, reply: ["250-mailpit", "250 SIZE 10240000"] },
    { expect: /^MAIL FROM/i, reply: "250 Ok" },
    { expect: /^RCPT TO/i, reply: "250 Ok" },
    { expect: /^DATA/i, reply: "354 go" },
    { expect: /^\.$/, reply: "250 queued" },
    { expect: /^QUIT/i, reply: "221 bye" },
  ]
}

/** Records every request and answers with a scripted response. A string
 *  payload comes back as text and a `Uint8Array` as bytes, so the raw and
 *  attachment routes are exercised the way Mailpit answers them. */
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
    if (payload instanceof Uint8Array) {
      return new Response(payload.buffer as ArrayBuffer, {
        status,
        headers: { "content-type": "application/octet-stream" },
      })
    }
    if (typeof payload === "string") {
      return new Response(payload, { status, headers: { "content-type": "text/plain" } })
    }
    return new Response(payload == null ? "" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const summary = (over: Record<string, unknown> = {}) => ({
  ID: "4oRBnPtCXgAqZniRhzLNmS",
  MessageID: "abc@acme.com",
  Read: false,
  From: { Name: "Acme", Address: "dev@acme.com" },
  To: [{ Name: "Ada", Address: "ada@example.com" }],
  Cc: [],
  Bcc: [],
  ReplyTo: [],
  Subject: "hi",
  Created: "2023-11-14T22:13:20.000Z",
  Size: 1234,
  Attachments: 0,
  Snippet: "hello",
  Tags: [],
  ...over,
})

const full = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  Date: "2023-11-14T22:13:20.000Z",
  Text: "hello",
  HTML: "",
  Attachments: [],
  Inline: [],
  ReturnPath: "dev@acme.com",
  ...over,
})

const listing = (messages: unknown[]) => ({
  messages,
  messages_count: messages.length,
  messages_unread: 0,
  start: 0,
  tags: [],
  total: messages.length,
  unread: 0,
})

describe("mailpit", () => {
  describe("sending", () => {
    it("delivers over SMTP and reports itself as the driver", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailpit({ host: server.host, port: server.port }),
        defaults,
      })
      const { data, error } = await email.send(msg)

      expect(error).toBeNull()
      expect(data?.driver).toBe("mailpit")
      expect(data?.id).toMatch(/^<.+>$/)

      const transcript = server.received.join("\n")
      expect(transcript).toContain("MAIL FROM:<dev@acme.com>")
      expect(transcript).toContain("RCPT TO:<ada@example.com>")
      expect(transcript).toContain("Subject: hi")
      // Mailpit needs no credentials out of the box, so none are offered.
      expect(transcript).not.toContain("AUTH")
      await email.dispose()
    })

    it("puts an attachment on the wire base64-encoded", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailpit({ host: server.host, port: server.port }),
        defaults,
      })
      await email.send({
        ...msg,
        attachments: [{ filename: "note.txt", content: "test", contentType: "text/plain" }],
      })

      const transcript = server.received.join("\n")
      expect(transcript).toContain('filename="note.txt"')
      expect(transcript).toContain("dGVzdA==")
      await email.dispose()
    })

    it("tags the message with the X-Tags header Mailpit reads", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailpit({ host: server.host, port: server.port }),
        defaults,
      })
      await email.send({
        ...msg,
        tags: [
          { name: "welcome", value: "v2" },
          { name: "billing", value: "" },
        ],
      })

      const transcript = server.received.join("\n")
      expect(transcript).toContain("X-Tags: welcome,billing")
      expect(transcript).toContain("X-Tag-welcome: v2")
      // An empty value has no header of its own.
      expect(transcript).not.toContain("X-Tag-billing:")
      await email.dispose()
    })

    it("leaves an X-Tags header the caller set alone", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailpit({ host: server.host, port: server.port }),
        defaults,
      })
      await email.send({
        ...msg,
        headers: { "X-Tags": "manual" },
        tags: [{ name: "welcome", value: "v2" }],
      })

      const transcript = server.received.join("\n")
      expect(transcript).toContain("X-Tags: manual")
      expect(transcript).not.toContain("X-Tags: welcome")
      await email.dispose()
    })

    it("accepts a sandbox message, because nothing it takes is ever delivered", async () => {
      server = await startFakeServer(happyPath())
      const email = createEmail({
        driver: mailpit({ host: server.host, port: server.port }),
        defaults,
      })
      const { error } = await email.send({ ...msg, sandbox: true })
      expect(error).toBeNull()
      await email.dispose()
    })

    it("returns an SMTP refusal as a Result rather than throwing", async () => {
      server = await startFakeServer([
        { reply: "220 mailpit ESMTP" },
        { expect: /^EHLO/i, reply: "250 mailpit" },
        { expect: /^MAIL FROM/i, reply: "550 no" },
      ])
      const email = createEmail({
        driver: mailpit({ host: server.host, port: server.port }),
        defaults,
      })
      const { error } = await email.send(msg)
      expect(error).toBeTruthy()
      expect(error?.driver).toBe("smtp")
      expect(error?.message).toContain("550")
      await email.dispose()
    })

    it("reports a catcher that is not listening rather than hanging", async () => {
      const email = createEmail({
        // Port 1 is reserved and nothing listens on it.
        driver: mailpit({ host: "127.0.0.1", port: 1, connectionTimeoutMs: 1_000 }),
        defaults,
      })
      const { error } = await email.send(msg)
      expect(error).toBeTruthy()
      expect(error?.driver).toBe("smtp")
      await email.dispose()
    })

    it("declines scheduling, which a catcher cannot honour", async () => {
      const { error } = await createEmail({ driver: mailpit(), defaults }).send({
        ...msg,
        scheduledAt: "2030-01-01T00:00:00Z",
      })
      expect(error?.code).toBe("UNSUPPORTED")
    })

    it("refuses a remote attachment it cannot fetch", async () => {
      const { error } = await createEmail({ driver: mailpit(), defaults }).send({
        ...msg,
        attachments: [{ filename: "a.pdf", url: "https://acme.com/a.pdf" }],
      })
      expect(error?.code).toBe("UNSUPPORTED")
    })
  })

  describe("the inbox", () => {
    it("reads Mailpit's default HTTP port and v1 route", async () => {
      const s = stubFetch(() => [200, listing([])])
      await mailpit({ fetch: s.fetch }).getInstance().list()
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/messages")
      expect(s.calls[0]!.method).toBe("GET")
    })

    it("moves every route under --webroot", async () => {
      const s = stubFetch(() => [200, listing([])])
      await mailpit({ fetch: s.fetch, webroot: "/mail/" }).getInstance().list()
      expect(s.calls[0]!.url).toBe("http://localhost:8025/mail/api/v1/messages")
    })

    it("takes a full base URL when one is given", async () => {
      const s = stubFetch(() => [200, listing([])])
      await mailpit({ fetch: s.fetch, httpEndpoint: "https://pit.internal/" }).getInstance().list()
      expect(s.calls[0]!.url).toBe("https://pit.internal/api/v1/messages")
    })

    it("sends --ui-auth credentials as basic auth", async () => {
      const s = stubFetch(() => [200, listing([])])
      await mailpit({ fetch: s.fetch, apiUser: "me", apiPassword: "secret" }).getInstance().list()
      expect(s.calls[0]!.headers.authorization).toBe(
        `Basic ${Buffer.from("me:secret").toString("base64")}`,
      )
    })

    it("unwraps the listing envelope and keeps Mailpit's own order", async () => {
      const s = stubFetch(() => [200, listing([summary({ ID: "new" }), summary({ ID: "old" })])])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().list({ start: 10, limit: 5 })
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/messages?start=10&limit=5")
      expect(data?.map((m) => m.ID)).toEqual(["new", "old"])
    })

    it("searches with Mailpit's own query language", async () => {
      const s = stubFetch(() => [200, listing([summary()])])
      const { data } = await mailpit({ fetch: s.fetch })
        .getInstance()
        .search("tag:welcome is:unread", { limit: 5, tz: "Pacific/Auckland" })

      const url = new URL(s.calls[0]!.url)
      expect(url.pathname).toBe("/api/v1/search")
      expect(url.searchParams.get("query")).toBe("tag:welcome is:unread")
      expect(url.searchParams.get("limit")).toBe("5")
      expect(url.searchParams.get("tz")).toBe("Pacific/Auckland")
      expect(data).toHaveLength(1)
    })

    it("fetches one message by id", async () => {
      const s = stubFetch(() => [200, full()])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().get("abc")
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/message/abc")
      expect(data?.Text).toBe("hello")
    })

    it("asks for `latest` instead of listing first", async () => {
      const s = stubFetch(() => [200, full({ Text: "newest" })])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().last()
      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/message/latest")
      expect(data?.Text).toBe("newest")
    })

    it("says so plainly when the inbox is empty", async () => {
      const s = stubFetch(() => [404, "404 page not found"])
      const { data, error } = await mailpit({ fetch: s.fetch }).getInstance().last()
      expect(error).toBeNull()
      expect(data).toBeNull()
    })

    it("does not read a broken API as an empty inbox", async () => {
      const s = stubFetch(() => [500, "boom"])
      const { error } = await mailpit({ fetch: s.fetch }).getInstance().last()
      expect(error?.code).toBe("NETWORK")
    })

    it("narrows `addressed:` down to the recipients it actually matched", async () => {
      const s = stubFetch(() => [
        200,
        listing([
          summary({ ID: "to", To: [{ Name: "", Address: "ada@example.com" }] }),
          summary({
            ID: "cc",
            To: [{ Name: "", Address: "other@x.com" }],
            Cc: [{ Name: "", Address: "ADA@example.com" }],
          }),
          // `addressed:` matches From and Reply-To as well, and matches by
          // substring — neither of these is a recipient of the message.
          summary({
            ID: "sender",
            From: { Name: "", Address: "ada@example.com" },
            To: [{ Name: "", Address: "other@x.com" }],
          }),
          summary({ ID: "prefix", To: [{ Name: "", Address: "ada@example.com.au" }] }),
        ]),
      ])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().find("ada@example.com")

      expect(new URL(s.calls[0]!.url).searchParams.get("query")).toBe("addressed:ada@example.com")
      expect(data?.map((m) => m.ID)).toEqual(["to", "cc"])
    })

    it("looks a Message-ID up with its angle brackets stripped", async () => {
      const s = stubFetch((url) =>
        url.includes("/search")
          ? [
              200,
              // Mailpit matches message-id with LIKE, so a longer id that
              // merely contains the query comes back too.
              listing([
                summary({ ID: "longer", MessageID: "xabc@acme.com" }),
                summary({ ID: "exact", MessageID: "abc@acme.com" }),
              ]),
            ]
          : [200, full({ ID: "exact" })],
      )
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().byMessageId("<abc@acme.com>")

      expect(new URL(s.calls[0]!.url).searchParams.get("query")).toBe("message-id:abc@acme.com")
      expect(s.calls[1]!.url).toBe("http://localhost:8025/api/v1/message/exact")
      expect(data?.ID).toBe("exact")
    })

    it("returns null for a Message-ID nothing matches", async () => {
      const s = stubFetch(() => [200, listing([summary({ MessageID: "elsewhere@x.com" })])])
      const { data, error } = await mailpit({ fetch: s.fetch })
        .getInstance()
        .byMessageId("<missing@acme.com>")
      expect(error).toBeNull()
      expect(data).toBeNull()
    })

    it("reads the raw RFC 5322 source as text", async () => {
      const raw = "Subject: hi\r\nMessage-ID: <abc@acme.com>\r\n\r\nhello\r\n"
      const s = stubFetch(() => [200, raw])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().raw("abc")
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/message/abc/raw")
      expect(data).toBe(raw)
    })

    it("reads an attachment's bytes", async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const s = stubFetch(() => [200, bytes])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().attachment("abc", "2.1")
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/message/abc/part/2.1")
      expect([...(data ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47])
    })

    it("returns a failed raw read as a Result", async () => {
      const s = stubFetch(() => [404, "404 page not found"])
      const { error } = await mailpit({ fetch: s.fetch }).getInstance().raw("nope")
      expect(error?.code).toBe("PROVIDER")
      expect(error?.status).toBe(404)
      expect(error?.driver).toBe("mailpit")
    })

    it("reads every header as a list of values", async () => {
      const s = stubFetch(() => [200, { "Message-Id": ["<abc@acme.com>"], Received: ["a", "b"] }])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().headers("abc")
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/message/abc/headers")
      expect(data?.Received).toEqual(["a", "b"])
    })

    it("scores the HTML against real client support", async () => {
      const check = {
        Total: { Nodes: 12, Tests: 30, Supported: 90.5, Partial: 4.5, Unsupported: 5 },
        Warnings: [
          {
            Slug: "css-display-flex",
            Title: "display: flex",
            Description: "",
            Category: "css",
            URL: "https://www.caniemail.com/features/css-display-flex/",
            Tags: [],
            Keywords: "",
            NotesByNumber: {},
            Results: [
              {
                Family: "Outlook",
                Platform: "windows",
                Version: "2019",
                Support: "no",
                Name: "Outlook 2019",
                NoteNumber: "",
              },
            ],
            Score: { Found: 1, Supported: 60, Partial: 10, Unsupported: 30 },
          },
        ],
        Platforms: { Outlook: ["windows"] },
      }
      const s = stubFetch(() => [200, check])
      const { data } = await mailpit({ fetch: s.fetch }).getInstance().htmlCheck("abc")

      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/message/abc/html-check")
      expect(data?.Total.Unsupported).toBe(5)
      const outlook = data?.Warnings[0]?.Results.find((r) => r.Family === "Outlook")
      expect(outlook?.Support).toBe("no")
    })

    it("reports a message with no HTML part rather than inventing a score", async () => {
      const s = stubFetch(() => [400, "message does not contain HTML"])
      const { error } = await mailpit({ fetch: s.fetch }).getInstance().htmlCheck("abc")
      expect(error?.code).toBe("PROVIDER")
      expect(error?.status).toBe(400)
    })

    it("lists and sets tags", async () => {
      const s = stubFetch((url) => (url.endsWith("/tags") ? [200, ["welcome"]] : [200, "ok"]))
      const inbox = mailpit({ fetch: s.fetch }).getInstance()

      expect((await inbox.tags()).data).toEqual(["welcome"])
      await inbox.setTags(["a", "b"], ["welcome"])

      expect(s.calls[1]!.method).toBe("PUT")
      expect(s.calls[1]!.url).toBe("http://localhost:8025/api/v1/tags")
      expect(s.calls[1]!.body).toEqual({ IDs: ["a", "b"], Tags: ["welcome"] })
    })

    it("deletes by id, and clears with no body at all", async () => {
      const s = stubFetch(() => [200, "ok"])
      const inbox = mailpit({ fetch: s.fetch }).getInstance()
      await inbox.delete("abc")
      await inbox.delete(["a", "b"])
      await inbox.clear()

      expect(s.calls.map((c) => [c.method, c.url, c.body])).toEqual([
        ["DELETE", "http://localhost:8025/api/v1/messages", { IDs: ["abc"] }],
        ["DELETE", "http://localhost:8025/api/v1/messages", { IDs: ["a", "b"] }],
        ["DELETE", "http://localhost:8025/api/v1/messages", undefined],
      ])
    })

    it("never turns an empty delete into a wipe", async () => {
      const s = stubFetch(() => [200, "ok"])
      const { error } = await mailpit({ fetch: s.fetch }).getInstance().delete([])
      expect(error).toBeNull()
      // Mailpit reads an absent `IDs` as "delete everything".
      expect(s.calls).toHaveLength(0)
    })

    it("turns an HTTP failure into a Result", async () => {
      const s = stubFetch(() => [503, "down"])
      const { error } = await mailpit({ fetch: s.fetch }).getInstance().list()
      expect(error?.code).toBe("NETWORK")
      expect(error?.retryable).toBe(true)
      expect(error?.driver).toBe("mailpit")
    })
  })

  describe("availability and retrieval", () => {
    it("reads the version out of /api/v1/info", async () => {
      const s = stubFetch(() => [200, { Version: "1.21.0", Messages: 3, Unread: 1 }])
      const driver = mailpit({ fetch: s.fetch })
      expect((await driver.getInstance().version()).data).toBe("1.21.0")
      expect((await driver.getInstance().info()).data?.Messages).toBe(3)
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/info")
    })

    it("is available when the API answers, and not when it does not", async () => {
      const up = stubFetch(() => [200, { Version: "1.21.0" }])
      const down = stubFetch(() => [502, "bad gateway"])
      expect(await mailpit({ fetch: up.fetch }).isAvailable?.()).toBe(true)
      expect(await mailpit({ fetch: down.fetch }).isAvailable?.()).toBe(false)
    })

    it("retrieves by Mailpit's own id without searching first", async () => {
      const s = stubFetch(() => [200, full()])
      const { data } = await createEmail({
        driver: mailpit({ fetch: s.fetch }),
        defaults,
      }).retrieve("4oRBnPtCXgAqZniRhzLNmS")

      expect(s.calls).toHaveLength(1)
      expect(s.calls[0]!.url).toBe("http://localhost:8025/api/v1/message/4oRBnPtCXgAqZniRhzLNmS")
      expect(data?.state).toBe("delivered")
      expect(data?.at?.toISOString()).toBe("2023-11-14T22:13:20.000Z")
    })

    it("finds the message a send returned, by the Message-ID it answered with", async () => {
      server = await startFakeServer(happyPath())
      let messageId = ""
      const s = stubFetch((url) => {
        if (url.includes("/search")) {
          return [200, listing([summary({ MessageID: messageId.replace(/^<|>$/g, "") })])]
        }
        return [200, full()]
      })

      const email = createEmail({
        driver: mailpit({ host: server.host, port: server.port, fetch: s.fetch }),
        defaults,
      })
      const { data: sent } = await email.send(msg)
      messageId = sent!.id

      const { data } = await email.retrieve(sent!.id)
      expect(data?.id).toBe("4oRBnPtCXgAqZniRhzLNmS")
      expect(data?.state).toBe("delivered")
      await email.dispose()
    })

    it("reports a Message-ID it cannot find rather than an empty status", async () => {
      const s = stubFetch(() => [200, listing([])])
      const { error } = await createEmail({
        driver: mailpit({ fetch: s.fetch }),
        defaults,
      }).retrieve("<missing@acme.com>")

      expect(error?.code).toBe("PROVIDER")
      expect(error?.message).toMatch(/<missing@acme.com>/)
    })

    it("surfaces a failure met during the Message-ID search", async () => {
      const s = stubFetch(() => [503, "gone"])
      const { error } = await createEmail({
        driver: mailpit({ fetch: s.fetch }),
        defaults,
      }).retrieve("<anything@acme.com>")
      expect(error?.code).toBe("NETWORK")
    })
  })
})
