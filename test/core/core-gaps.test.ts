import { describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/core/email.ts"
import { normalizeMessage } from "../../src/core/message.ts"
import { attachmentToBase64 } from "../../src/drivers/_base64.ts"
import { httpBytes, httpJson, httpText } from "../../src/drivers/_fetch.ts"
import mock from "../../src/drivers/mock.ts"
import postmark from "../../src/drivers/postmark.ts"

const defaults = { from: "Acme <hi@acme.com>" }
const to = "ada@example.com"

describe("a subject is required unless a template supplies one", () => {
  it("rejects a message with neither", () => {
    expect(() => normalizeMessage({ from: "a@b.com", to, text: "t" })).toThrow(
      /`subject` is required unless `template` is set/,
    )
  })

  it("accepts a templated message with no subject", () => {
    const msg = normalizeMessage({ from: "a@b.com", to, template: { alias: "welcome" } })
    expect(msg.subject).toBeUndefined()
    expect(msg.template?.alias).toBe("welcome")
  })

  it("keeps an explicit subject on a templated message", () => {
    const msg = normalizeMessage({
      from: "a@b.com",
      to,
      subject: "override",
      template: { alias: "welcome" },
    })
    expect(msg.subject).toBe("override")
  })

  it("still rejects a non-string subject", () => {
    expect(() =>
      normalizeMessage({ from: "a@b.com", to, subject: 42 as unknown as string, text: "t" }),
    ).toThrow(/must be a string/)
  })

  it("lets a driver omit it entirely rather than send an empty one", async () => {
    const calls: { body: Record<string, unknown> }[] = []
    const stub = (async (_url: string | URL, init: RequestInit = {}) => {
      calls.push({ body: JSON.parse(init.body as string) })
      return new Response(JSON.stringify({ MessageID: "m" }), { status: 200 })
    }) as unknown as typeof fetch

    await createEmail({ driver: postmark({ token: "t", fetch: stub }), defaults }).send({
      to,
      template: { alias: "welcome", variables: { name: "Ada" } },
    })

    expect(calls[0]!.body).not.toHaveProperty("Subject")
    expect(calls[0]!.body).toMatchObject({ TemplateAlias: "welcome" })
  })
})

describe("an attachment the provider fetches itself", () => {
  it("accepts a url instead of content", () => {
    const msg = normalizeMessage({
      from: "a@b.com",
      to,
      subject: "s",
      text: "t",
      attachments: [{ filename: "invoice.pdf", url: "https://acme.com/i/1.pdf" }],
    })
    expect(msg.attachments[0]?.url).toBe("https://acme.com/i/1.pdf")
  })

  it("refuses both at once, and neither", () => {
    const both = {
      from: "a@b.com",
      to,
      subject: "s",
      text: "t",
      attachments: [{ filename: "a.pdf", content: "x", url: "https://acme.com/a.pdf" }],
    }
    expect(() => normalizeMessage(both)).toThrow(/exactly one of `content` and `url`, not both/)

    const neither = { ...both, attachments: [{ filename: "a.pdf" }] }
    expect(() => normalizeMessage(neither)).toThrow(/exactly one of `content` and `url`/)
  })

  it("is refused by a driver that has not claimed remoteAttachments", async () => {
    const driver = mock()
    const { error } = await createEmail({ driver, defaults }).send({
      to,
      subject: "s",
      text: "t",
      attachments: [{ filename: "a.pdf", url: "https://acme.com/a.pdf" }],
    })

    expect(error?.code).toBe("UNSUPPORTED")
    expect(error?.message).toContain("`attachments[].url`")
    expect(driver.getInstance().messages).toHaveLength(0)
  })

  it("reaches a driver that has claimed it", async () => {
    const driver = { ...mock(), features: { ...mock().features, remoteAttachments: true } }
    const { error } = await createEmail({ driver, defaults }).send({
      to,
      subject: "s",
      text: "t",
      attachments: [{ filename: "a.pdf", url: "https://acme.com/a.pdf" }],
    })
    expect(error).toBeNull()
  })

  it("cannot be base64-encoded, and says why", () => {
    expect(() => attachmentToBase64({ filename: "a.pdf", url: "https://acme.com/a.pdf" })).toThrow(
      /has a url, not content/,
    )
  })
})

describe("responses that are not JSON", () => {
  const respond = (body: BodyInit, init?: ResponseInit) =>
    (async () => new Response(body, init)) as unknown as typeof fetch

  it("httpText returns the body verbatim", async () => {
    const raw = "From: a@b.com\r\nSubject: hi\r\n\r\nbody"
    const result = await httpText({ fetch: respond(raw), driver: "d", url: "https://x.test" })
    expect(result.data).toBe(raw)
  })

  it("httpJson would have discarded it", async () => {
    const result = await httpJson({
      fetch: respond("not json at all"),
      driver: "d",
      url: "https://x.test",
    })
    expect(result.data).toBeNull()
    expect(result.error).toBeNull()
  })

  it("httpBytes returns the body as bytes", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const result = await httpBytes({
      fetch: respond(bytes),
      driver: "d",
      url: "https://x.test",
    })
    expect([...(result.data ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it("classifies a failure the same way, and keeps a readable reason", async () => {
    const result = await httpText({
      fetch: respond("no such message", { status: 404 }),
      driver: "d",
      url: "https://x.test",
    })
    expect(result.error?.code).toBe("PROVIDER")
    expect(result.error?.message).toContain("no such message")
  })

  it("still honours classify, onResponse and retryability", async () => {
    let seen: string | null = null
    const result = await httpText({
      fetch: respond("slow down", { status: 503, headers: { "retry-after": "5" } }),
      driver: "d",
      url: "https://x.test",
      onResponse: (response) => {
        seen = response.headers.get("retry-after")
      },
    })
    expect(seen).toBe("5")
    expect(result.error?.code).toBe("NETWORK")
    expect(result.error?.retryable).toBe(true)
  })

  it("defaults to GET, unlike httpJson", async () => {
    const calls: string[] = []
    const spy = (async (_url: string | URL, init: RequestInit = {}) => {
      calls.push(init.method ?? "GET")
      return new Response("ok")
    }) as unknown as typeof fetch

    await httpText({ fetch: spy, driver: "d", url: "https://x.test" })
    await httpJson({ fetch: spy, driver: "d", url: "https://x.test" })
    expect(calls).toEqual(["GET", "POST"])
  })

  it("reports a body that dies mid-stream as retryable", async () => {
    const dying = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("terminated"))
          },
        }),
      )) as unknown as typeof fetch

    const result = await httpText({ fetch: dying, driver: "d", url: "https://x.test" })
    expect(result.error?.code).toBe("NETWORK")
    expect(result.error?.retryable).toBe(true)
  })

  it("forwards an abort signal", async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging = (async (_url: string | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
      })
      controller.abort()
      return new Response("ok")
    }) as unknown as typeof fetch

    await httpText({
      fetch: hanging,
      driver: "d",
      url: "https://x.test",
      signal: controller.signal,
    })
    expect(aborted).toBe(true)
  })

  it("sends a verbatim body like httpJson does", async () => {
    const bodies: unknown[] = []
    const spy = (async (_url: string | URL, init: RequestInit = {}) => {
      bodies.push(init.body)
      return new Response("ok")
    }) as unknown as typeof fetch

    const form = new FormData()
    await httpText({ fetch: spy, driver: "d", url: "https://x.test", bodyInit: form })
    expect(bodies[0]).toBe(form)
  })
})

describe("the logger no longer assumes a subject", () => {
  it("omits it for a templated send", async () => {
    const entries: { messages?: readonly { to: string; subject?: string }[] }[] = []
    const { withLogger } = await import("../../src/middleware/logger.ts")
    const email = createEmail({
      driver: mock(),
      defaults,
      use: [withLogger({ redact: "none", log: (entry) => entries.push(entry) })],
    })
    await email.send({ to, template: { alias: "welcome" } })
    expect(entries[0]?.messages?.[0]).toEqual({ to })
  })
})

describe("mock still records what it is given", () => {
  it("keeps a templated message intact", async () => {
    const driver = mock()
    const send = vi.fn()
    void send
    await createEmail({ driver, defaults }).send({ to, template: { id: "42" } })
    expect(driver.getInstance().last()).toMatchObject({ template: { id: "42" } })
  })
})

describe("cancel and retrieve carry the instance signal", () => {
  it("hands it to the driver", async () => {
    const seen: (AbortSignal | undefined)[] = []
    const controller = new AbortController()
    const driver = {
      ...mock(),
      cancel: async (_id: string, ctx: { signal?: AbortSignal }) => {
        seen.push(ctx?.signal)
        return { data: undefined, error: null } as const
      },
      retrieve: async (id: string, ctx: { signal?: AbortSignal }) => {
        seen.push(ctx?.signal)
        return {
          data: { id, driver: "mock", state: "sent" as const },
          error: null,
        } as const
      },
    }

    const email = createEmail({ driver, defaults, signal: controller.signal })
    await email.cancel("x")
    await email.retrieve("x")

    expect(seen).toEqual([controller.signal, controller.signal])
  })

  it("passes nothing when the instance has no signal", async () => {
    const seen: unknown[] = []
    const driver = {
      ...mock(),
      retrieve: async (id: string, ctx: { signal?: AbortSignal }) => {
        seen.push(ctx?.signal)
        return {
          data: { id, driver: "mock", state: "sent" as const },
          error: null,
        } as const
      },
    }
    await createEmail({ driver, defaults }).retrieve("x")
    expect(seen).toEqual([undefined])
  })
})
