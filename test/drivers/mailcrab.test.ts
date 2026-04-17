import { afterEach, describe, expect, it, vi } from "vitest"
import { createEmail } from "../../src/index.ts"
import mailcrab from "../../src/drivers/mailcrab.ts"
import { startFakeServer } from "./_smtp/fake-server.ts"
import type { FakeServerHandle } from "./_smtp/fake-server.ts"

let active: FakeServerHandle | null = null
afterEach(async () => {
  if (active) await active.close()
  active = null
})

const happyPath = [
  { reply: "220 crab ESMTP" },
  { expect: /^EHLO /, reply: ["250-crab hello", "250 SIZE 10240000"] },
  { expect: /^MAIL FROM:/, reply: "250 ok" },
  { expect: /^RCPT TO:/, reply: "250 ok" },
  { expect: /^DATA$/, reply: "354 send data" },
  { expect: /^\.$/, reply: "250 ok queued" },
  { expect: /^QUIT$/, reply: "221 bye" },
]

describe("mailcrab driver", () => {
  it("delegates to the SMTP driver on localhost:port", async () => {
    active = await startFakeServer(happyPath)
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const email = createEmail({
      driver: mailcrab({
        host: active.host,
        port: active.port,
        uiPort: 1080,
      }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.driver).toBe("mailcrab")
    // First send prints a pointer to the UI.
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("http://"))
    await email.dispose()
    infoSpy.mockRestore()
  })

  it("respects quiet: true", async () => {
    active = await startFakeServer(happyPath)
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    infoSpy.mockClear()
    const email = createEmail({
      driver: mailcrab({ host: active.host, port: active.port, quiet: true }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(infoSpy).not.toHaveBeenCalled()
    await email.dispose()
    infoSpy.mockRestore()
  })
})
