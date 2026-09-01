import { describe, expect, it, vi } from "vitest"
import type { EmailDriver, EmailResult, Result } from "../../src/core/types.ts"
import { createEmail } from "../../src/core/email.ts"
import { defineMiddleware } from "../../src/core/define.ts"
import { createError } from "../../src/core/error.ts"
import { err, ok } from "../../src/core/result.ts"
import mock from "../../src/drivers/mock.ts"

const msg = { to: "ada@example.com", subject: "hi", text: "hello" } as const
const defaults = { from: "Acme <hi@acme.com>" }

describe("send", () => {
  it("returns the provider id on success", async () => {
    const email = createEmail({ driver: mock(), defaults })
    const { data, error } = await email.send(msg)
    expect(error).toBeNull()
    expect(data?.driver).toBe("mock")
    expect(data?.id).toMatch(/^mock_/)
  })

  it("returns a normalization failure as a Result, never a throw", async () => {
    const email = createEmail({ driver: mock() })
    const { data, error } = await email.send(msg)
    expect(data).toBeNull()
    expect(error?.code).toBe("INVALID_OPTIONS")
  })

  it("hands the driver a normalized message", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults })
    await email.send({ ...msg, to: "Ada <ada@example.com>" })
    expect(driver.getInstance().last()?.to).toEqual([{ email: "ada@example.com", name: "Ada" }])
  })

  it("survives a driver that throws", async () => {
    const driver: EmailDriver = {
      name: "boom",
      send() {
        throw new Error("kaboom")
      },
    }
    const { error } = await createEmail({ driver, defaults }).send(msg)
    expect(error?.code).toBe("PROVIDER")
    expect(error?.message).toContain("kaboom")
  })
})

describe("sendBatch", () => {
  it("keeps results positional and reports partial failure", async () => {
    const driver = mock({ failWhen: (_m, index) => index === 1 })
    const email = createEmail({ driver, defaults })
    const batch = await email.sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b" },
      { ...msg, subject: "c" },
    ])

    expect(batch.ok).toBe(false)
    expect(batch.results).toHaveLength(3)
    expect(batch.sent).toHaveLength(2)
    expect(batch.failed).toEqual([{ index: 1, error: expect.any(Error) }])
    expect(batch.results[0]!.data).not.toBeNull()
    expect(batch.results[1]!.error).not.toBeNull()
    expect(batch.results[2]!.data).not.toBeNull()
  })

  it("does not let one invalid message take down the batch", async () => {
    const driver = mock()
    const batch = await createEmail({ driver, defaults }).sendBatch([
      { ...msg, subject: "good" },
      { ...msg, to: "nonsense", subject: "bad" },
      { ...msg, subject: "also good" },
    ])
    expect(batch.sent).toHaveLength(2)
    expect(batch.failed[0]?.index).toBe(1)
    expect(batch.failed[0]?.error.code).toBe("INVALID_OPTIONS")
    expect(driver.getInstance().messages.map((m) => m.subject)).toEqual(["good", "also good"])
  })

  it("uses the driver's native batch when there is one", async () => {
    const sendBatch = vi.fn(async (msgs: readonly unknown[]) =>
      msgs.map((_, index) => ok({ id: `id_${index}`, driver: "native", at: new Date() })),
    )
    const driver = { name: "native", send: vi.fn(), sendBatch } as unknown as EmailDriver
    const batch = await createEmail({ driver, defaults }).sendBatch([msg, msg])
    expect(sendBatch).toHaveBeenCalledOnce()
    expect(batch.sent.map((r) => r.id)).toEqual(["id_0", "id_1"])
  })

  it("fails loudly when a driver loses the 1:1 mapping", async () => {
    const driver = {
      name: "sloppy",
      send: vi.fn(),
      sendBatch: async () => [ok({ id: "only-one", driver: "sloppy", at: new Date() })],
    } as unknown as EmailDriver
    const batch = await createEmail({ driver, defaults }).sendBatch([msg, msg])
    expect(batch.ok).toBe(false)
    expect(batch.failed).toHaveLength(2)
    expect(batch.failed[0]?.error.message).toMatch(/1 results for 2 messages/)
  })

  it("returns an empty batch for an empty input", async () => {
    const batch = await createEmail({ driver: mock(), defaults }).sendBatch([])
    expect(batch).toMatchObject({ ok: true, results: [], sent: [], failed: [] })
  })
})

describe("sendStream", () => {
  it("yields one result per message", async () => {
    const email = createEmail({ driver: mock(), defaults })
    const seen: Result<EmailResult>[] = []
    const input = Array.from({ length: 7 }, (_, i) => ({ ...msg, subject: `s${i}` }))
    for await (const result of email.sendStream(input, { chunkSize: 3 })) seen.push(result)
    expect(seen).toHaveLength(7)
    expect(seen.every((r) => r.error === null)).toBe(true)
  })

  it("accepts an async iterable source", async () => {
    async function* source() {
      yield { ...msg, subject: "a" }
      yield { ...msg, subject: "b" }
    }
    const email = createEmail({ driver: mock(), defaults })
    const seen = []
    for await (const result of email.sendStream(source())) seen.push(result)
    expect(seen).toHaveLength(2)
  })
})

describe("mounts", () => {
  it("routes by stream and falls back to the default driver", async () => {
    const primary = mock()
    const broadcast = mock()
    const email = createEmail({ driver: primary, defaults }).mount("broadcast", broadcast)

    await email.send(msg)
    await email.send({ ...msg, stream: "broadcast" })
    await email.send({ ...msg, stream: "unknown" })

    expect(primary.getInstance().messages).toHaveLength(2)
    expect(broadcast.getInstance().messages).toHaveLength(1)
  })

  it("splits one batch across the drivers its messages target", async () => {
    const primary = mock()
    const broadcast = mock()
    const email = createEmail({ driver: primary, defaults }).mount("broadcast", broadcast)
    const batch = await email.sendBatch([
      { ...msg, subject: "a" },
      { ...msg, subject: "b", stream: "broadcast" },
      { ...msg, subject: "c" },
    ])
    expect(batch.sent).toHaveLength(3)
    expect(primary.getInstance().messages.map((m) => m.subject)).toEqual(["a", "c"])
    expect(broadcast.getInstance().messages.map((m) => m.subject)).toEqual(["b"])
  })

  it("unmount disposes by default and stops routing", async () => {
    const broadcast = mock()
    const dispose = vi.fn()
    const email = createEmail({ driver: mock(), defaults })
    email.mount("b", { ...broadcast, dispose })
    await email.unmount("b")
    expect(dispose).toHaveBeenCalledOnce()
    expect(email.getMounts()).toEqual([])
  })
})

describe("initialize", () => {
  it("runs once even when sends race", async () => {
    const initialize = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const email = createEmail({ driver: { ...mock(), initialize }, defaults })
    await Promise.all([email.send(msg), email.send(msg), email.send(msg)])
    expect(initialize).toHaveBeenCalledOnce()
  })

  it("finishes before the driver is asked to send", async () => {
    const order: string[] = []
    const driver: EmailDriver = {
      name: "ordered",
      async initialize() {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push("initialize")
      },
      send() {
        order.push("send")
        return ok({ id: "1", driver: "ordered", at: new Date() })
      },
    }
    await Promise.all([
      createEmail({ driver, defaults }).send(msg),
      createEmail({ driver, defaults }).send(msg),
    ])
    expect(order[0]).toBe("initialize")
  })

  it("initializes a driver mounted after the first send", async () => {
    const initialize = vi.fn()
    const email = createEmail({ driver: mock(), defaults })
    await email.send(msg)

    email.mount("late", { ...mock(), initialize })
    await email.send({ ...msg, stream: "late" })
    expect(initialize).toHaveBeenCalledOnce()
  })

  it("surfaces an initialize failure as a Result", async () => {
    const driver = {
      ...mock(),
      initialize: () => {
        throw createError("mock", "AUTH", "bad credentials")
      },
    }
    const { error } = await createEmail({ driver, defaults }).send(msg)
    expect(error?.code).toBe("AUTH")
  })
})

describe("cancel and retrieve", () => {
  it("reports UNSUPPORTED rather than throwing", async () => {
    const email = createEmail({ driver: mock(), defaults })
    expect((await email.cancel("x")).error?.code).toBe("UNSUPPORTED")
    expect((await email.retrieve("x")).error?.code).toBe("UNSUPPORTED")
  })

  it("delegates to a driver that supports them", async () => {
    const driver: EmailDriver = {
      ...mock(),
      cancel: async () => ok(undefined),
      retrieve: async (id) => ok({ id, driver: "mock", state: "delivered" as const }),
    }
    const email = createEmail({ driver, defaults })
    expect((await email.cancel("x")).error).toBeNull()
    expect((await email.retrieve("x")).data?.state).toBe("delivered")
  })
})

describe("middleware", () => {
  it("runs outermost-first in registration order", async () => {
    const order: string[] = []
    const tag = (name: string) =>
      defineMiddleware(name, (next) => async (msgs, ctx) => {
        order.push(`>${name}`)
        const results = await next(msgs, ctx)
        order.push(`<${name}`)
        return results
      })

    const email = createEmail({ driver: mock(), defaults }).use(tag("a")).use(tag("b"))
    await email.send(msg)
    expect(order).toEqual([">a", ">b", "<b", "<a"])
  })

  it("can replace the message before the driver sees it", async () => {
    const driver = mock()
    const email = createEmail({ driver, defaults }).use(
      defineMiddleware(
        "rewrite",
        (next) => (msgs, ctx) =>
          next(
            msgs.map((m) => ({ ...m, subject: `[tagged] ${m.subject}` })),
            ctx,
          ),
      ),
    )
    await email.send(msg)
    expect(driver.getInstance().last()?.subject).toBe("[tagged] hi")
  })

  it("contains a middleware that throws", async () => {
    const email = createEmail({ driver: mock(), defaults }).use(
      defineMiddleware("explodes", () => () => {
        throw new Error("middleware bug")
      }),
    )
    const { error } = await email.send(msg)
    expect(error?.message).toContain("middleware bug")
  })

  it("rejects a middleware that returns the wrong number of results", async () => {
    const email = createEmail({ driver: mock(), defaults }).use(
      defineMiddleware("drops", () => async () => [
        ok({ id: "1", driver: "mock", at: new Date() }),
      ]),
    )
    const batch = await email.sendBatch([msg, msg])
    expect(batch.ok).toBe(false)
    expect(batch.failed[0]?.error.message).toMatch(/returned 1 of 2 results/)
  })

  it("is applied to every mounted driver", async () => {
    const seen: string[] = []
    const email = createEmail({ driver: mock(), defaults })
      .mount("b", mock())
      .use(
        defineMiddleware("watch", (next) => (msgs, ctx) => {
          seen.push(ctx.driver)
          return next(msgs, ctx)
        }),
      )
    await email.send(msg)
    await email.send({ ...msg, stream: "b" })
    expect(seen).toEqual(["mock", "mock"])
  })
})

describe("isAvailable", () => {
  it("defaults to true and never propagates a throw", async () => {
    const bare = createEmail({
      driver: { name: "bare", send: () => ok({ id: "1", driver: "bare", at: new Date() }) },
      defaults,
    })
    expect(await bare.isAvailable()).toBe(true)

    const angry = createEmail({
      driver: {
        name: "angry",
        isAvailable() {
          throw new Error("no")
        },
        send: () => err(createError("angry", "PROVIDER", "no")),
      },
      defaults,
    })
    expect(await angry.isAvailable()).toBe(false)
  })
})

describe("abort", () => {
  it("cancels a batch on a driver that batches natively", async () => {
    const controller = new AbortController()
    controller.abort()
    const driver = mock()
    const email = createEmail({ driver, defaults, signal: controller.signal })

    const batch = await email.sendBatch([msg, msg])

    expect(batch.ok).toBe(false)
    expect(batch.results.every((r) => r.error?.code === "CANCELLED")).toBe(true)
    expect(driver.getInstance().messages).toHaveLength(0)
  })

  it("cancels a single send the same way", async () => {
    const controller = new AbortController()
    controller.abort()
    const driver = mock()
    const { error } = await createEmail({ driver, defaults, signal: controller.signal }).send(msg)
    expect(error?.code).toBe("CANCELLED")
    expect(driver.getInstance().messages).toHaveLength(0)
  })
})

describe("the mounts option", () => {
  it("routes exactly like mount()", async () => {
    const a = mock()
    const b = mock()
    const email = createEmail({ driver: a, mounts: { b }, defaults })
    await email.send({ ...msg, stream: "b" })
    await email.send(msg)
    expect(a.getInstance().messages).toHaveLength(1)
    expect(b.getInstance().messages).toHaveLength(1)
    expect(email.getMounts().map((m) => m.stream)).toEqual(["b"])
  })
})

describe("context meta", () => {
  it("reaches the caller on a success", async () => {
    const email = createEmail({ driver: mock(), defaults }).use(
      defineMiddleware("timing", (next) => async (msgs, ctx) => {
        const results = await next(msgs, ctx)
        ctx.meta.durationMs = 42
        return results
      }),
    )
    const { data } = await email.send(msg)
    expect(data?.meta).toEqual({ durationMs: 42 })
  })

  it("reaches the caller on a failure too", async () => {
    const email = createEmail({ driver: mock({ fail: true }), defaults }).use(
      defineMiddleware("trace", (next) => async (msgs, ctx) => {
        ctx.meta.traceId = "abc"
        return next(msgs, ctx)
      }),
    )
    const { error } = await email.send(msg)
    expect(error?.meta).toEqual({ traceId: "abc" })
  })

  it("is absent when no middleware wrote anything", async () => {
    const { data } = await createEmail({ driver: mock(), defaults }).send(msg)
    expect(data?.meta).toBeUndefined()
  })
})

describe("dispose", () => {
  it("disposes the default driver and every mount, once", async () => {
    const disposeA = vi.fn()
    const disposeB = vi.fn()
    const email = createEmail({ driver: { ...mock(), dispose: disposeA }, defaults })
    email.mount("b", { ...mock(), dispose: disposeB })
    await email.dispose()
    expect(disposeA).toHaveBeenCalledOnce()
    expect(disposeB).toHaveBeenCalledOnce()
  })
})
