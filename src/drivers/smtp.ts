import type { DriverWithInstance, NormalizedMessage } from "../core/types.ts"
import type { AuthMethod } from "./_smtp/auth.ts"
import type { ConnectionOptions } from "./_smtp/connection.ts"
import type { ConnectionPool } from "./_smtp/pool.ts"
import type { DkimSignerOptions } from "./_smtp/dkim.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError, toEmailError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { buildMime, resolveMessageId, toMimeInput } from "./_mime.ts"
import { createPool } from "./_smtp/pool.ts"
import { signDkim } from "./_smtp/dkim.ts"

export type { DkimSignerOptions }

export interface SmtpOptions {
  host: string
  /** Defaults to 465 when `secure`, 587 otherwise. */
  port?: number
  /** Implicit TLS from the first byte (port 465). Default: false, which
   *  means plain connect then STARTTLS. */
  secure?: boolean
  /** Refuse to send if STARTTLS is unavailable. */
  requireTLS?: boolean
  user?: string
  password?: string
  /** Default `AUTO` picks the strongest method the server advertises. */
  authMethod?: AuthMethod | "AUTO"
  /** Supply an OAuth2 bearer token for XOAUTH2. */
  getAccessToken?: () => Promise<string>
  /** Default: true. Turning it off accepts any certificate — only ever
   *  reasonable against a local test server. */
  rejectUnauthorized?: boolean
  tls?: import("node:tls").ConnectionOptions
  /** Name sent in EHLO. Defaults to the machine's hostname. */
  localName?: string

  /** Keep connections open between sends. Default: false. */
  pool?: boolean
  maxConnections?: number
  maxMessagesPerConnection?: number
  idleTimeoutMs?: number
  connectionTimeoutMs?: number
  commandTimeoutMs?: number
  disposeGraceMs?: number

  /** Sign outbound mail with DKIM (RFC 6376 / RFC 8463). Pass a function
   *  to select a key per message, for multi-tenant sending. */
  dkim?: DkimSignerOptions | ((msg: NormalizedMessage) => DkimSignerOptions | null)
}

const DRIVER = "smtp"

/**
 * Speaks SMTP directly — no `nodemailer`, no transitive dependencies.
 * Requires `node:net` and `node:tls`, so this is the one driver that does
 * not run in a Worker.
 *
 * ```ts
 * createEmail({ driver: smtp({ host: "smtp.acme.com", user, password, pool: true }) })
 * ```
 */
const smtp: (options: SmtpOptions) => DriverWithInstance<ConnectionPool> = defineDriver<
  SmtpOptions,
  ConnectionPool
>((options) => {
  if (!options?.host) throw createRequiredError(DRIVER, "host")

  const secure = options.secure ?? false
  const connection: ConnectionOptions = {
    host: options.host,
    port: options.port ?? (secure ? 465 : 587),
    secure,
    requireTLS: options.requireTLS,
    user: options.user,
    password: options.password,
    authMethod: options.authMethod ?? "AUTO",
    getAccessToken: options.getAccessToken,
    rejectUnauthorized: options.rejectUnauthorized ?? true,
    tls: options.tls,
    localName: options.localName ?? resolveLocalName(),
    connectionTimeoutMs: options.connectionTimeoutMs ?? 30_000,
    commandTimeoutMs: options.commandTimeoutMs ?? 10_000,
  }

  let pool: ConnectionPool | null = null
  const getPool = () =>
    (pool ??= createPool({
      enabled: options.pool ?? false,
      maxConnections: options.maxConnections ?? 5,
      maxMessagesPerConnection: options.maxMessagesPerConnection ?? 0,
      idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
      disposeGraceMs: options.disposeGraceMs ?? 10_000,
      connection,
    }))

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      replyTo: true,
      customHeaders: true,
    },

    getInstance: getPool,

    async dispose() {
      if (!pool) return
      await pool.dispose()
      pool = null
    },

    async send(msg) {
      const messageId = resolveMessageId(msg, options.host)

      let envelope: { from: string; rcpt: string[] }
      let document: string
      try {
        if (msg.raw != null) {
          document = typeof msg.raw === "string" ? msg.raw : new TextDecoder().decode(msg.raw)
          envelope = {
            from: msg.from.email,
            rcpt: [...new Set([...msg.to, ...msg.cc, ...msg.bcc].map((a) => a.email))],
          }
        } else {
          const mime = buildMime(toMimeInput(msg, messageId))
          envelope = mime.envelope
          document = mime.body
        }
        if (envelope.rcpt.length === 0) {
          throw createError(DRIVER, "INVALID_OPTIONS", "at least one recipient is required")
        }
        const dkim = typeof options.dkim === "function" ? options.dkim(msg) : options.dkim
        if (dkim) document = await signDkim(document, dkim)
      } catch (error) {
        return err(toEmailError(DRIVER, error))
      }

      const conn = await getPool().acquire()
      let failed = false
      try {
        await conn.sendMessage(envelope, document)
        return ok({
          id: messageId,
          driver: DRIVER,
          ...(msg.stream ? { stream: msg.stream } : {}),
          at: new Date(),
          provider: { authMethods: [...conn.capabilities.authMethods] },
        })
      } catch (error) {
        failed = true
        return err(toEmailError(DRIVER, error))
      } finally {
        // A connection that failed mid-transaction is discarded rather
        // than returned to the pool in an unknown protocol state.
        await getPool()
          .release(conn, failed)
          .catch(() => {})
      }
    },
  }
})

export default smtp

/** EHLO wants a name the server can look up. `require` is reached
 *  indirectly so bundlers targeting a Worker do not try to resolve
 *  `node:os` at build time. */
function resolveLocalName(): string {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process
  if (!proc?.versions?.node) return "localhost"
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require
    const os = req?.("node:os") as { hostname?: () => string } | undefined
    const hostname = os?.hostname?.()
    return hostname && /^[\w.-]+$/.test(hostname) ? hostname : "localhost.localdomain"
  } catch {
    return "localhost.localdomain"
  }
}
