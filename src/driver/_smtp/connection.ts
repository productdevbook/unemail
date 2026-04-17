import type { Socket } from "node:net"
import type { TLSSocket } from "node:tls"
import type { AuthMethod, SmtpReply } from "./auth.ts"
import { authCramMd5, authLogin, authPlain, authXoauth2, pickAuthMethod } from "./auth.ts"
import { cancelledError, replyError, timeoutError, wrapNetworkError } from "./errors.ts"
import { ReplyParser } from "./reply.ts"
import { dotStuff } from "./mime.ts"

/** Knobs mirror what's user-visible on `SmtpDriverOptions`. Kept narrow so
 *  this module is easy to unit-test. */
export interface ConnectionOptions {
  host: string
  port: number
  secure: boolean
  requireTLS?: boolean
  user?: string
  password?: string
  authMethod?: AuthMethod | "AUTO"
  getAccessToken?: () => Promise<string>
  rejectUnauthorized?: boolean
  tls?: import("node:tls").ConnectionOptions
  localName: string
  connectionTimeoutMs: number
  commandTimeoutMs: number
}

export interface Capabilities {
  authMethods: Set<AuthMethod>
  starttls: boolean
  size: number
  smtputf8: boolean
}

/** A live SMTP connection. `sendMessage` handles MAIL FROM → RCPT TO →
 *  DATA; callers can reuse the same instance for multiple messages via
 *  `reset()` (issues `RSET`). */
export interface SmtpConnection {
  id: number
  capabilities: Capabilities
  sendMessage: (envelope: { from: string; rcpt: string[] }, body: string) => Promise<void>
  reset: () => Promise<void>
  quit: () => Promise<void>
  destroy: () => void
  isOpen: () => boolean
}

let connectionCounter = 0

/** Establish an SMTP connection: TCP connect → optional implicit TLS →
 *  EHLO → optional STARTTLS → re-EHLO → AUTH. Returns when ready to send. */
export async function createConnection(opts: ConnectionOptions): Promise<SmtpConnection> {
  const { default: net } = await import("node:net")
  const { default: tls } = await import("node:tls")
  const id = ++connectionCounter

  let socket: Socket | TLSSocket = opts.secure
    ? tls.connect({
        host: opts.host,
        port: opts.port,
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
        ...opts.tls,
      })
    : net.connect({ host: opts.host, port: opts.port })

  const pending: PendingReply[] = []
  const parser = new ReplyParser((reply) => {
    const waiter = pending.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(reply)
    }
  })

  socket.setEncoding("utf8")
  socket.on("data", (chunk: string | Buffer) =>
    parser.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
  )

  const onCloseReason = { value: undefined as Error | undefined }
  socket.on("error", (err: Error) => failAll(pending, wrapNetworkError(err)))
  socket.on("close", () => {
    const err = onCloseReason.value ?? wrapNetworkError(new Error("connection closed"))
    failAll(pending, err)
  })

  const setup = async () => {
    await waitForConnect(socket, opts.connectionTimeoutMs, opts.secure)
    const greet = await recvInternal(pending, opts.commandTimeoutMs, "greeting")
    if (greet.code !== 220) throw replyError(greet.code, greet.raw, "greeting")
    return ehlo(pending, socket, opts.localName, opts.commandTimeoutMs)
  }
  let caps: Capabilities
  try {
    caps = await setup()
  } catch (err) {
    socket.destroy()
    throw err
  }

  try {
    // STARTTLS if advertised and we're not already secure.
    if (!opts.secure && caps.starttls) {
      await sendInternal(socket, "STARTTLS")
      const reply = await recvInternal(pending, opts.commandTimeoutMs, "STARTTLS")
      if (reply.code !== 220) throw replyError(reply.code, reply.raw, "STARTTLS")
      socket = await upgradeTls(socket as Socket, tls, opts)
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string | Buffer) =>
        parser.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
      )
      socket.on("error", (err: Error) => failAll(pending, wrapNetworkError(err)))
      socket.on("close", () => {
        const err = onCloseReason.value ?? wrapNetworkError(new Error("connection closed"))
        failAll(pending, err)
      })
      caps = await ehlo(pending, socket, opts.localName, opts.commandTimeoutMs)
    } else if (opts.requireTLS && !opts.secure) {
      throw new Error(`[unemail] [smtp] STARTTLS required but not offered by ${opts.host}`)
    }

    // AUTH (if credentials provided and server advertises methods).
    if (opts.user && (opts.password || opts.getAccessToken)) {
      const method = pickAuthMethod(caps.authMethods, opts.authMethod)
      if (!method) throw new Error(`[unemail] [smtp] no supported AUTH method advertised`)
      const authCtx = {
        send: (line: string) => sendInternal(socket, line),
        recv: () => recvInternal(pending, opts.commandTimeoutMs, `AUTH ${method}`),
      }
      let reply: SmtpReply
      if (method === "PLAIN") reply = await authPlain(authCtx, opts.user, opts.password!)
      else if (method === "LOGIN") reply = await authLogin(authCtx, opts.user, opts.password!)
      else if (method === "CRAM-MD5") {
        const { default: crypto } = await import("node:crypto")
        reply = await authCramMd5(authCtx, opts.user, opts.password!, (key, data) =>
          crypto.createHmac("md5", key).update(data).digest("hex"),
        )
      } else {
        const token = opts.getAccessToken ? await opts.getAccessToken() : opts.password!
        reply = await authXoauth2(authCtx, opts.user, token)
      }
      if (reply.code !== 235) throw replyError(reply.code, reply.raw, `AUTH ${method}`)
    }
  } catch (err) {
    socket.destroy()
    throw err
  }

  const connection: SmtpConnection = {
    id,
    capabilities: caps,
    async sendMessage(envelope, body) {
      await sendInternal(socket, `MAIL FROM:<${envelope.from}>`)
      const mailReply = await recvInternal(pending, opts.commandTimeoutMs, "MAIL FROM")
      if (mailReply.code !== 250) throw replyError(mailReply.code, mailReply.raw, "MAIL FROM")
      for (const rcpt of envelope.rcpt) {
        await sendInternal(socket, `RCPT TO:<${rcpt}>`)
        const rcptReply = await recvInternal(pending, opts.commandTimeoutMs, "RCPT TO")
        if (rcptReply.code !== 250 && rcptReply.code !== 251)
          throw replyError(rcptReply.code, rcptReply.raw, "RCPT TO")
      }
      await sendInternal(socket, "DATA")
      const dataReply = await recvInternal(pending, opts.commandTimeoutMs, "DATA")
      if (dataReply.code !== 354) throw replyError(dataReply.code, dataReply.raw, "DATA")
      await sendInternal(socket, dotStuff(body) + "\r\n.")
      const endReply = await recvInternal(pending, opts.commandTimeoutMs, "DATA-end")
      if (endReply.code !== 250) throw replyError(endReply.code, endReply.raw, "DATA-end")
    },
    async reset() {
      await sendInternal(socket, "RSET")
      const reply = await recvInternal(pending, opts.commandTimeoutMs, "RSET")
      if (reply.code !== 250) throw replyError(reply.code, reply.raw, "RSET")
    },
    async quit() {
      try {
        await sendInternal(socket, "QUIT")
        await recvInternal(pending, opts.commandTimeoutMs, "QUIT").catch(() => {})
      } finally {
        socket.destroy()
      }
    },
    destroy() {
      onCloseReason.value = cancelledError("connection destroyed")
      socket.destroy()
    },
    isOpen() {
      return !socket.destroyed && socket.writable
    },
  }

  return connection
}

interface PendingReply {
  stage: string
  resolve: (reply: SmtpReply) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function failAll(pending: PendingReply[], err: Error): void {
  while (pending.length > 0) {
    const waiter = pending.shift()!
    clearTimeout(waiter.timer)
    waiter.reject(err)
  }
}

async function sendInternal(socket: Socket | TLSSocket, line: string): Promise<void> {
  const payload = `${line}\r\n`
  if (!socket.write(payload)) {
    await new Promise<void>((resolve) => socket.once("drain", () => resolve()))
  }
}

function recvInternal(
  pending: PendingReply[],
  timeoutMs: number,
  stage: string,
): Promise<SmtpReply> {
  return new Promise<SmtpReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove ourselves from the queue and reject.
      const idx = pending.findIndex((p) => p.timer === timer)
      if (idx >= 0) pending.splice(idx, 1)
      reject(timeoutError(stage, timeoutMs))
    }, timeoutMs)
    pending.push({ stage, resolve, reject, timer })
  })
}

async function ehlo(
  pending: PendingReply[],
  socket: Socket | TLSSocket,
  localName: string,
  timeoutMs: number,
): Promise<Capabilities> {
  await sendInternal(socket, `EHLO ${localName}`)
  const reply = await recvInternal(pending, timeoutMs, "EHLO")
  if (reply.code !== 250) throw replyError(reply.code, reply.raw, "EHLO")
  return parseCapabilities(reply)
}

function parseCapabilities(reply: SmtpReply): Capabilities {
  const caps: Capabilities = {
    authMethods: new Set<AuthMethod>(),
    starttls: false,
    size: 0,
    smtputf8: false,
  }
  // Skip the first line (server greeting echo); parse the rest.
  for (const line of reply.lines.slice(1)) {
    const upper = line.toUpperCase()
    if (upper === "STARTTLS") caps.starttls = true
    else if (upper === "SMTPUTF8") caps.smtputf8 = true
    else if (upper.startsWith("SIZE")) {
      const size = Number(upper.split(/\s+/)[1] ?? 0)
      if (Number.isFinite(size)) caps.size = size
    } else if (upper.startsWith("AUTH")) {
      const methods = upper.slice(4).split(/\s+/).filter(Boolean)
      for (const m of methods) {
        if (m === "PLAIN" || m === "LOGIN" || m === "CRAM-MD5" || m === "XOAUTH2")
          caps.authMethods.add(m as AuthMethod)
      }
    }
  }
  return caps
}

async function waitForConnect(
  socket: Socket | TLSSocket,
  timeoutMs: number,
  secure: boolean,
): Promise<void> {
  const event = secure ? "secureConnect" : "connect"
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(timeoutError("connect", timeoutMs))
    }, timeoutMs)
    const onConnect = () => {
      clearTimeout(timer)
      socket.off("error", onError)
      resolve()
    }
    const onError = (err: Error) => {
      clearTimeout(timer)
      socket.off(event, onConnect)
      reject(wrapNetworkError(err, "connect"))
    }
    socket.once(event, onConnect)
    socket.once("error", onError)
  })
}

async function upgradeTls(
  socket: Socket,
  tls: typeof import("node:tls"),
  opts: ConnectionOptions,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(timeoutError("STARTTLS upgrade", opts.connectionTimeoutMs)),
      opts.connectionTimeoutMs,
    )
    const secure = tls.connect({
      socket,
      servername: opts.host,
      rejectUnauthorized: opts.rejectUnauthorized ?? true,
      ...opts.tls,
    })
    secure.once("secureConnect", () => {
      clearTimeout(timer)
      resolve(secure)
    })
    secure.once("error", (err: Error) => {
      clearTimeout(timer)
      reject(wrapNetworkError(err, "STARTTLS upgrade"))
    })
  })
}
