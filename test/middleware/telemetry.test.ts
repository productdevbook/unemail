import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { withTelemetry, type OtelSpan, type OtelTracer } from "../../src/middleware/telemetry.ts"
import mock from "../../src/driver/mock.ts"

function makeFakeTracer(): {
  tracer: OtelTracer
  events: Array<{ kind: string; payload: unknown }>
} {
  const events: Array<{ kind: string; payload: unknown }> = []
  const tracer: OtelTracer = {
    startActiveSpan(name, options, fn) {
      events.push({ kind: "start", payload: { name, attributes: options.attributes } })
      const span: OtelSpan = {
        setAttribute(key, value) {
          events.push({ kind: "attr", payload: { key, value } })
        },
        recordException(err) {
          events.push({ kind: "exception", payload: { message: (err as Error).message } })
        },
        setStatus(status) {
          events.push({ kind: "status", payload: status })
        },
        end() {
          events.push({ kind: "end", payload: null })
        },
      }
      return fn(span)
    },
  }
  return { tracer, events }
}

describe("withTelemetry", () => {
  it("opens a span on send, attaches message_id on success, and closes it", async () => {
    const { tracer, events } = makeFakeTracer()
    const email = createEmail({ driver: mock() })
    email.use(withTelemetry({ tracer }))

    const { data } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
    })

    const kinds = events.map((e) => e.kind)
    expect(kinds[0]).toBe("start")
    expect(kinds.includes("attr")).toBe(true)
    expect(kinds.at(-1)).toBe("end")
    const attrs = events.find((e) => e.kind === "start")!.payload as {
      attributes: Record<string, unknown>
    }
    expect(attrs.attributes["email.driver"]).toBe("mock")
    expect(attrs.attributes["email.to"]).toBe("c@d.com")
    const messageIdAttr = events.find(
      (e) => e.kind === "attr" && (e.payload as { key: string }).key === "email.message_id",
    )
    expect((messageIdAttr!.payload as { value: string }).value).toBe(data!.id)
  })

  it("records an error status when the driver fails", async () => {
    const { tracer, events } = makeFakeTracer()
    const email = createEmail({ driver: mock({ fail: true }) })
    email.use(withTelemetry({ tracer }))
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    const status = events.find((e) => e.kind === "status")
    expect(status).toBeDefined()
    expect((status!.payload as { code: number }).code).toBe(2)
  })

  it("skips span creation when sample() returns false", async () => {
    const { tracer, events } = makeFakeTracer()
    const email = createEmail({ driver: mock() })
    email.use(withTelemetry({ tracer, sample: () => false }))
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(events).toEqual([])
  })

  it("is a no-op when no tracer is provided", async () => {
    const email = createEmail({ driver: mock() })
    email.use(withTelemetry())
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error).toBeNull()
  })
})
