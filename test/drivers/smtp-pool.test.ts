import { afterEach, describe, expect, it } from "vitest"
import type { FakeServerHandle, ScriptLine } from "./_smtp/fake-server.ts"
import { startFakeServer } from "./_smtp/fake-server.ts"
import { createPool } from "../../src/drivers/_smtp/pool.ts"
import type { PoolOptions } from "../../src/drivers/_smtp/pool.ts"

let server: FakeServerHandle | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

/** Greeting, EHLO, then one transaction, repeated enough times that a
 *  reconnect is scripted too. */
function script(transactions = 4): ScriptLine[] {
  const lines: ScriptLine[] = [
    { reply: "220 test.local ESMTP" },
    { expect: /^EHLO/i, reply: "250 test.local" },
  ]
  for (let i = 0; i < transactions; i++) {
    lines.push(
      { expect: /^MAIL FROM/i, reply: "250 Ok" },
      { expect: /^RCPT TO/i, reply: "250 Ok" },
      { expect: /^DATA/i, reply: "354 go" },
      { expect: /^\.$/, reply: "250 queued" },
    )
  }
  lines.push({ expect: /^QUIT/i, reply: "221 bye" })
  return lines
}

function poolOptions(over: Partial<PoolOptions> = {}): PoolOptions {
  return {
    enabled: true,
    maxConnections: 2,
    maxMessagesPerConnection: 0,
    idleTimeoutMs: 60_000,
    disposeGraceMs: 1000,
    connection: {
      host: server!.host,
      port: server!.port,
      secure: false,
      authMethod: "AUTO",
      rejectUnauthorized: true,
      localName: "test.local",
      connectionTimeoutMs: 5000,
      commandTimeoutMs: 5000,
    },
    ...over,
  }
}

const envelope = { from: "f@x.com", rcpt: ["a@x.com"] }
const document = "Subject: s\r\n\r\nbody"

describe("connection pool", () => {
  it("reuses one connection across sends when pooling is on", async () => {
    server = await startFakeServer(script())
    const pool = createPool(poolOptions())

    const first = await pool.acquire()
    await first.sendMessage(envelope, document)
    await pool.release(first)

    expect(pool.size()).toMatchObject({ idle: 1, inFlight: 0 })

    const second = await pool.acquire()
    expect(second).toBe(first)
    await second.sendMessage(envelope, document)
    await pool.release(second)

    // One EHLO means one connection served both messages.
    expect(server.received.filter((line) => /^EHLO/i.test(line))).toHaveLength(1)
    await pool.dispose()
  })

  it("discards a connection that failed mid-transaction rather than reusing it", async () => {
    server = await startFakeServer(script())
    const pool = createPool(poolOptions())

    const conn = await pool.acquire()
    await pool.release(conn, true)

    expect(pool.size()).toMatchObject({ idle: 0, inFlight: 0 })
    await pool.dispose()
  })

  it("retires a connection once maxMessagesPerConnection is reached", async () => {
    server = await startFakeServer([...script(2), ...script(2).slice(0)])
    const pool = createPool(poolOptions({ maxMessagesPerConnection: 1 }))

    const conn = await pool.acquire()
    await conn.sendMessage(envelope, document)
    await pool.release(conn)

    // Used once, cap is one: it must not go back into the idle set.
    expect(pool.size().idle).toBe(0)
    await pool.dispose()
  })

  it("opens a fresh connection per send when pooling is off", async () => {
    server = await startFakeServer(script())
    const pool = createPool(poolOptions({ enabled: false }))

    const conn = await pool.acquire()
    await pool.release(conn)
    expect(pool.size().idle).toBe(0)
    await pool.dispose()
  })

  it("tracks in-flight connections, so dispose can wait for them", async () => {
    server = await startFakeServer(script())
    const pool = createPool(poolOptions())

    const conn = await pool.acquire()
    expect(pool.size()).toMatchObject({ idle: 0, inFlight: 1 })

    await pool.release(conn)
    expect(pool.size()).toMatchObject({ idle: 1, inFlight: 0 })
    await pool.dispose()
  })

  it("closes everything on dispose and refuses to hand out more", async () => {
    server = await startFakeServer(script())
    const pool = createPool(poolOptions())

    const conn = await pool.acquire()
    await pool.release(conn)
    await pool.dispose()

    expect(pool.size()).toMatchObject({ idle: 0, inFlight: 0 })
    await expect(pool.acquire()).rejects.toThrow()
  })

  it("is safe to dispose twice", async () => {
    server = await startFakeServer(script())
    const pool = createPool(poolOptions())
    await pool.dispose()
    await expect(pool.dispose()).resolves.toBeUndefined()
  })

  it("drops an idle connection once the idle timeout elapses", async () => {
    server = await startFakeServer(script())
    const pool = createPool(poolOptions({ idleTimeoutMs: 20 }))

    const conn = await pool.acquire()
    await pool.release(conn)
    expect(pool.size().idle).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pool.size().idle).toBe(0)
    await pool.dispose()
  })
})
