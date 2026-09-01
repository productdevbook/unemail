import { describe, expect, it, vi } from "vitest"
import type { EmailDriver, SendContext } from "../../src/core/types.ts"
import {
  compose,
  defineMiddleware,
  driverHandler,
  perMessage,
  wrap,
} from "../../src/core/define.ts"
import { createError } from "../../src/core/error.ts"
import { createEmail } from "../../src/core/email.ts"
import { normalizeMessage } from "../../src/core/message.ts"
import { err, ok } from "../../src/core/result.ts"
import mock from "../../src/drivers/mock.ts"

const msg = normalizeMessage({
  from: "f@x.com",
  to: "a@x.com",
  subject: "s",
  text: "t",
})
const ctx = (over: Partial<SendContext> = {}): SendContext => ({
  driver: "mock",
  attempt: 1,
  meta: {},
  ...over,
})
const accept: EmailDriver = {
  name: "accept",
  send: () => ok({ id: "1", driver: "accept", at: new Date() }),
}

describe("compose", () => {
  it("makes the first middleware the outermost", async () => {
    const order: string[] = []
    const tag = (name: string) =>
      defineMiddleware(name, (next) => async (msgs, c) => {
        order.push(`>${name}`)
        const results = await next(msgs, c)
        order.push(`<${name}`)
        return results
      })
    await compose([tag("a"), tag("b")], driverHandler(accept))([msg], ctx())
    expect(order).toEqual([">a", ">b", "<b", "<a"])
  })

  it("returns the handler untouched when there is no middleware", async () => {
    const results = await compose([], driverHandler(accept))([msg], ctx())
    expect(results).toHaveLength(1)
  })
})

describe("driverHandler", () => {
  it("returns one result per input", async () => {
    const results = await driverHandler(accept)([msg, msg, msg], ctx())
    expect(results).toHaveLength(3)
  })

  it("returns an empty list for no messages, without touching the driver", async () => {
    const send = vi.fn()
    expect(await driverHandler({ name: "n", send })([], ctx())).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it("prefers sendBatch only when there is more than one message", async () => {
    const sendBatch = vi.fn(async (msgs: readonly unknown[]) =>
      msgs.map(() => ok({ id: "b", driver: "n", at: new Date() })),
    )
    const send = vi.fn(() => ok({ id: "s", driver: "n", at: new Date() }))
    const driver = { name: "n", send, sendBatch } as unknown as EmailDriver

    await driverHandler(driver)([msg], ctx())
    expect(send).toHaveBeenCalledOnce()
    expect(sendBatch).not.toHaveBeenCalled()

    await driverHandler(driver)([msg, msg], ctx())
    expect(sendBatch).toHaveBeenCalledOnce()
  })

  it("turns a throwing sendBatch into a failure per message", async () => {
    const driver = {
      name: "n",
      send: vi.fn(),
      sendBatch: () => {
        throw new Error("boom")
      },
    } as unknown as EmailDriver
    const results = await driverHandler(driver)([msg, msg], ctx())
    expect(results.map((r) => r.error?.message)).toEqual([
      expect.stringContaining("boom"),
      expect.stringContaining("boom"),
    ])
  })
})

describe("wrap", () => {
  it("returns the same driver when given no middleware", () => {
    const driver = mock()
    expect(wrap(driver)).toBe(driver)
  })

  it("applies middleware to both send and sendBatch", async () => {
    const driver = mock()
    const wrapped = wrap(
      driver,
      defineMiddleware(
        "stamp",
        (next) => (msgs, c) =>
          next(
            msgs.map((m) => ({ ...m, subject: `[w] ${m.subject}` })),
            c,
          ),
      ),
    )
    await wrapped.send(msg, ctx())
    await wrapped.sendBatch!([msg], ctx())
    expect(driver.getInstance().messages.map((m) => m.subject)).toEqual(["[w] s", "[w] s"])
  })

  it("keeps the driver's own name and features", () => {
    const driver = mock()
    const wrapped = wrap(
      driver,
      defineMiddleware("noop", (next) => next),
    )
    expect(wrapped.name).toBe(driver.name)
    expect(wrapped.features).toEqual(driver.features)
  })
})

describe("perMessage", () => {
  it("lifts a per-message function over a batch", async () => {
    const driver = mock()
    const email = createEmail({
      driver,
      defaults: { from: "f@x.com" },
      use: [
        perMessage(
          "stamp",
          (next) => async (m, c) => next({ ...m, subject: `[p] ${m.subject}` }, c),
        ),
      ],
    })
    const batch = await email.sendBatch([
      { to: "a@x.com", subject: "1", text: "t" },
      { to: "b@x.com", subject: "2", text: "t" },
    ])
    expect(batch.ok).toBe(true)
    expect(driver.getInstance().messages.map((m) => m.subject)).toEqual(["[p] 1", "[p] 2"])
  })

  it("lets a per-message function short-circuit just its own message", async () => {
    const driver = mock()
    const email = createEmail({
      driver,
      defaults: { from: "f@x.com" },
      use: [
        perMessage(
          "gate",
          (next) => async (m, c) =>
            m.subject === "blocked"
              ? err(createError("gate", "INVALID_OPTIONS", "no"))
              : next(m, c),
        ),
      ],
    })
    const batch = await email.sendBatch([
      { to: "a@x.com", subject: "ok", text: "t" },
      { to: "b@x.com", subject: "blocked", text: "t" },
    ])
    expect(batch.sent).toHaveLength(1)
    expect(batch.failed[0]?.index).toBe(1)
    expect(driver.getInstance().messages).toHaveLength(1)
  })
})
