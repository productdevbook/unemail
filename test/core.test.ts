import { describe, expect, it } from "vitest"
import { createEmail, defineDriver } from "../src/index.ts"
import mock from "../src/driver/mock.ts"

describe("createEmail", () => {
  it("sends via the default driver and returns {data, error}", async () => {
    const email = createEmail({ driver: mock() })
    const { data, error } = await email.send({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.driver).toBe("mock")
    expect(data?.id).toMatch(/^mock_/)
  })

  it("routes by mounted stream", async () => {
    const transactional = mock()
    const marketing = mock()
    const email = createEmail({ driver: transactional }).mount("marketing", marketing)

    await email.send({ from: "a@b.com", to: "c@d.com", subject: "tx", text: "1" })
    await email.send({
      stream: "marketing",
      from: "a@b.com",
      to: "c@d.com",
      subject: "mk",
      text: "2",
    })

    expect(transactional.getInstance?.()).toHaveLength(1)
    expect(marketing.getInstance?.()).toHaveLength(1)
  })

  it("memoizes results by idempotency key", async () => {
    const driver = mock()
    const email = createEmail({ driver, idempotency: true })

    const a = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "once",
      text: "x",
      idempotencyKey: "welcome/42",
    })
    const b = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "once",
      text: "x",
      idempotencyKey: "welcome/42",
    })

    expect(a.data?.id).toBe(b.data?.id)
    expect(driver.getInstance?.()).toHaveLength(1)
  })

  it("runs middleware hooks in order", async () => {
    const calls: string[] = []
    const email = createEmail({ driver: mock() }).use({
      beforeSend: () => {
        calls.push("before")
      },
      afterSend: () => {
        calls.push("after")
      },
    })

    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    expect(calls).toEqual(["before", "after"])
  })

  it("sendBatchStream yields one Result per message without short-circuiting", async () => {
    let call = 0
    const email = createEmail({
      driver: defineDriver(() => ({
        name: "alt",
        send: () => {
          call++
          if (call === 2) {
            return {
              data: null,
              error: {
                name: "EmailError",
                message: "bad",
                driver: "alt",
                code: "PROVIDER",
                retryable: false,
              } as never,
            }
          }
          return {
            data: { id: `id_${call}`, driver: "alt", at: new Date() },
            error: null,
          }
        },
      }))(),
    })

    const messages = [1, 2, 3].map((n) => ({
      from: "a@b.com",
      to: "c@d.com",
      subject: `s${n}`,
      text: "x",
    }))

    const outcomes: Array<"ok" | "err"> = []
    for await (const r of email.sendBatchStream(messages)) {
      outcomes.push(r.error ? "err" : "ok")
    }
    expect(outcomes).toEqual(["ok", "err", "ok"])
  })

  it("dispose() cascades to mounted drivers", async () => {
    let disposed = 0
    const driver = defineDriver(() => ({
      name: "probe",
      send: () => ({ data: null, error: null as never }),
      dispose: () => {
        disposed++
      },
    }))
    const email = createEmail({ driver: driver() }).mount("x", driver())
    await email.dispose()
    expect(disposed).toBe(2)
  })
})
