import net from "node:net"
import type { AddressInfo } from "node:net"

/** A scripted SMTP server used only in tests. Each line the client sends
 *  is matched against `script[i].expect`; if present, the server replies
 *  with `script[i].reply`. Catch-alls (`expect: /.*$/`) work too. */
export interface ScriptLine {
  expect?: RegExp | string
  reply: string | string[]
  delay?: number
  /** Close the socket after sending the reply — simulates 421-and-close. */
  close?: boolean
}

export interface FakeServerHandle {
  port: number
  host: string
  close: () => Promise<void>
  received: string[]
}

export function startFakeServer(script: ScriptLine[]): Promise<FakeServerHandle> {
  return new Promise((resolve, reject) => {
    const received: string[] = []
    const server = net.createServer((socket) => {
      let cursor = 0
      let inData = false
      let buffer = ""

      const write = (payload: string) =>
        socket.write(payload.endsWith("\r\n") ? payload : `${payload}\r\n`)

      // Greeting first.
      const greeting = script[cursor]
      if (greeting && greeting.expect === undefined) {
        cursor++
        const reply = Array.isArray(greeting.reply) ? greeting.reply.join("\r\n") : greeting.reply
        if (greeting.delay) setTimeout(() => write(reply), greeting.delay)
        else write(reply)
        if (greeting.close) socket.end()
      }

      socket.setEncoding("utf8")
      socket.on("data", (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
        while (true) {
          const idx = buffer.indexOf("\n")
          if (idx < 0) break
          const rawLine = buffer.slice(0, idx).replace(/\r$/, "")
          buffer = buffer.slice(idx + 1)

          if (inData) {
            received.push(rawLine)
            if (rawLine === ".") {
              inData = false
              respond(rawLine)
            }
            continue
          }
          received.push(rawLine)
          respond(rawLine)
        }
      })

      function respond(line: string): void {
        const step = script[cursor]
        if (!step) return
        cursor++
        if (step.expect instanceof RegExp && !step.expect.test(line)) {
          write(`500 unexpected: ${line}`)
          return
        }
        if (typeof step.expect === "string" && line !== step.expect) {
          write(`500 unexpected: ${line}`)
          return
        }
        if (line === "DATA") inData = true
        const reply = Array.isArray(step.reply) ? step.reply.join("\r\n") : step.reply
        const emit = () => {
          write(reply)
          if (step.close) socket.end()
        }
        if (step.delay) setTimeout(emit, step.delay)
        else emit()
      }
    })

    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo
      resolve({
        port: addr.port,
        host: "127.0.0.1",
        received,
        close: () =>
          new Promise((r) => {
            ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
            server.close(() => r())
          }),
      })
    })
  })
}
