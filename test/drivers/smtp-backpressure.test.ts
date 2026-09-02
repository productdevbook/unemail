import { afterEach, describe, expect, it } from "vitest"
import net from "node:net"
import { createConnection } from "../../src/drivers/_smtp/connection.ts"

let server: net.Server | null = null

afterEach(() => {
  server?.close()
  server = null
})

/**
 * Completes the handshake, then stops reading once DATA begins so the
 * client's write buffer fills, and kills the connection while it is full.
 */
async function stallingServer(): Promise<number> {
  server = net.createServer((sock) => {
    sock.setEncoding("utf8")
    sock.write("220 fake ESMTP\r\n")
    let inData = false
    sock.on("data", (chunk: string) => {
      if (inData) {
        sock.pause()
        setTimeout(() => sock.destroy(), 50)
        return
      }
      for (const line of chunk.split("\r\n").filter(Boolean)) {
        if (/^EHLO/i.test(line)) sock.write("250-fake\r\n250 SIZE 100000000\r\n")
        else if (/^DATA/i.test(line)) {
          sock.write("354 go\r\n")
          inData = true
        } else sock.write("250 ok\r\n")
      }
    })
    sock.on("error", () => {})
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()))
  return (server!.address() as net.AddressInfo).port
}

describe("a socket that dies while the write buffer is full", () => {
  it("rejects rather than hanging", async () => {
    const port = await stallingServer()
    const conn = await createConnection({
      host: "127.0.0.1",
      port,
      secure: false,
      authMethod: "AUTO",
      rejectUnauthorized: true,
      localName: "test.local",
      connectionTimeoutMs: 2000,
      commandTimeoutMs: 2000,
    })

    // Larger than the socket's 16 KB write buffer, so `write()` returns
    // false and the send has to wait for a drain that never comes.
    const body = `Subject: s\r\n\r\n${"x".repeat(4 * 1024 * 1024)}`

    const outcome = await Promise.race([
      conn.sendMessage({ from: "a@b.com", rcpt: ["c@d.com"] }, body).then(
        () => "resolved",
        (error: Error) => `rejected: ${error.message}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 4000)),
    ])

    expect(outcome).not.toBe("hung")
    expect(outcome).toMatch(/^rejected:/)
    conn.destroy()
  }, 15_000)
})
