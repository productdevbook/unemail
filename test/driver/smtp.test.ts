import { afterEach, describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import smtp from "../../src/driver/smtp.ts"
import { startFakeServer } from "./_smtp/fake-server.ts"
import type { FakeServerHandle } from "./_smtp/fake-server.ts"

let active: FakeServerHandle | null = null
afterEach(async () => {
  if (active) await active.close()
  active = null
})

const happyPath = [
  { reply: "220 test.example ESMTP" },
  { expect: /^EHLO /, reply: ["250-test.example hello", "250 SIZE 10240000"] },
  { expect: /^MAIL FROM:/, reply: "250 ok" },
  { expect: /^RCPT TO:/, reply: "250 ok" },
  { expect: /^DATA$/, reply: "354 end data with <CR><LF>.<CR><LF>" },
  { expect: /^\.$/, reply: "250 2.0.0 queued as abc" },
  { expect: /^QUIT$/, reply: "221 bye" },
]

describe("smtp driver", () => {
  it("sends through MAIL FROM / RCPT TO / DATA", async () => {
    active = await startFakeServer(happyPath)
    const email = createEmail({
      driver: smtp({
        host: active.host,
        port: active.port,
        secure: false,
        connectionTimeoutMs: 2000,
        commandTimeoutMs: 2000,
      }),
    })
    const { data, error } = await email.send({
      from: "sender@example.com",
      to: "rcpt@example.com",
      subject: "hi",
      text: "hello",
    })
    expect(error).toBeNull()
    expect(data?.driver).toBe("smtp")
    expect(data?.id).toMatch(/^</)
    await email.dispose()
  })

  it("maps 535 auth failure to AUTH error", async () => {
    active = await startFakeServer([
      { reply: "220 test.example ESMTP" },
      { expect: /^EHLO /, reply: ["250-test.example hello", "250 AUTH PLAIN LOGIN"] },
      { expect: /^AUTH PLAIN /, reply: "535 5.7.8 bad credentials" },
      { expect: /^QUIT$/, reply: "221 bye" },
    ])
    const email = createEmail({
      driver: smtp({
        host: active.host,
        port: active.port,
        secure: false,
        user: "u",
        password: "p",
        authMethod: "PLAIN",
      }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(data).toBeNull()
    expect(error?.code).toBe("AUTH")
    expect(error?.retryable).toBe(false)
    await email.dispose()
  })

  it("respects a short commandTimeoutMs without tearing down TLS (#21)", async () => {
    active = await startFakeServer([
      { reply: "220 test.example ESMTP" },
      { expect: /^EHLO /, delay: 2000, reply: "250 hello" },
    ])
    const email = createEmail({
      driver: smtp({
        host: active.host,
        port: active.port,
        secure: false,
        connectionTimeoutMs: 3000,
        commandTimeoutMs: 300,
      }),
    })
    const { error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(error?.code).toBe("TIMEOUT")
    expect(error?.retryable).toBe(true)
    await email.dispose()
  })

  it("uses localName in EHLO, not the server host (#8 Brevo)", async () => {
    active = await startFakeServer(happyPath)
    const email = createEmail({
      driver: smtp({
        host: active.host,
        port: active.port,
        secure: false,
        localName: "my-client.example",
        commandTimeoutMs: 2000,
      }),
    })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "x" })
    expect(active.received.some((line) => line === "EHLO my-client.example")).toBe(true)
    await email.dispose()
  })

  it("surfaces 550 on RCPT as PROVIDER (not retryable)", async () => {
    active = await startFakeServer([
      { reply: "220 test ESMTP" },
      { expect: /^EHLO /, reply: "250 hello" },
      { expect: /^MAIL FROM:/, reply: "250 ok" },
      { expect: /^RCPT TO:/, reply: "550 no such user" },
      { expect: /^QUIT$/, reply: "221 bye" },
    ])
    const email = createEmail({
      driver: smtp({ host: active.host, port: active.port, secure: false }),
    })
    const { data, error } = await email.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      text: "x",
    })
    expect(data).toBeNull()
    expect(error?.code).toBe("PROVIDER")
    expect(error?.retryable).toBe(false)
    await email.dispose()
  })
})
