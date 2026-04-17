import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import tee from "../../src/driver/tee.ts"
import mock from "../../src/driver/mock.ts"
import { createError } from "../../src/errors.ts"
import type { EmailDriver } from "../../src/types.ts"

describe("tee driver", () => {
  it("returns the primary driver's result and forwards to mirrors", async () => {
    const primary = mock()
    const mirror = mock()
    const email = createEmail({
      driver: tee({ drivers: [primary, mirror], awaitMirrors: true }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
    })
    expect(error).toBeNull()
    expect(data?.driver).toBe("mock")
    expect(primary.getInstance?.()).toHaveLength(1)
    expect(mirror.getInstance?.()).toHaveLength(1)
  })

  it("surfaces the primary driver's error but still runs mirrors", async () => {
    const failing: EmailDriver = {
      name: "bad",
      send: () => ({ data: null, error: createError("bad", "AUTH", "nope") }),
    }
    const mirror = mock()
    const email = createEmail({
      driver: tee({ drivers: [failing, mirror], awaitMirrors: true }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
    })
    expect(error?.code).toBe("AUTH")
    expect(mirror.getInstance?.()).toHaveLength(1)
  })

  it("reports mirror errors via onMirrorError without failing the send", async () => {
    const primary = mock()
    const dead: EmailDriver = {
      name: "dead",
      send: () => ({ data: null, error: createError("dead", "NETWORK", "down") }),
    }
    const reports: Array<{ name: string; message: string }> = []
    const email = createEmail({
      driver: tee({
        drivers: [primary, dead],
        awaitMirrors: true,
        onMirrorError: (name, err) => {
          reports.push({ name, message: err.message })
        },
      }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "x",
    })
    expect(error).toBeNull()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.name).toBe("dead")
  })
})
