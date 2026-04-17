import type { DriverFactory, EmailResult } from "../types.ts"
import type { ConnectionOptions } from "./_smtp/connection.ts"
import type { PoolOptions } from "./_smtp/pool.ts"
import type { AuthMethod } from "./_smtp/auth.ts"
import { defineDriver } from "../_define.ts"
import { EmailError } from "../errors.ts"
import { createError, createRequiredError, toEmailError } from "../errors.ts"
import { buildMime, normalizeMimeInput } from "./_smtp/mime.ts"
import { createPool, type ConnectionPool } from "./_smtp/pool.ts"
import { signDkim, type DkimSignerOptions } from "./_smtp/dkim.ts"

export type { DkimSignerOptions }

/** User-visible options. See `docs/drivers/smtp.md` (lands with #54) for
 *  the full matrix. Defaults favor security: `rejectUnauthorized: true`,
 *  AUTO auth, STARTTLS if the server advertises it. */
export interface SmtpDriverOptions {
  host: string
  port?: number
  secure?: boolean
  requireTLS?: boolean
  user?: string
  password?: string
  authMethod?: AuthMethod | "AUTO"
  getAccessToken?: () => Promise<string>
  rejectUnauthorized?: boolean
  tls?: import("node:tls").ConnectionOptions
  localName?: string
  pool?: boolean
  maxConnections?: number
  maxMessagesPerConnection?: number
  idleTimeoutMs?: number
  connectionTimeoutMs?: number
  commandTimeoutMs?: number
  disposeGraceMs?: number
  /** Sign outbound messages with DKIM (RFC 6376 / RFC 8463). Accepts a
   *  single signer config or a per-message resolver for multi-tenant
   *  sending. */
  dkim?: DkimSignerOptions | ((msg: import("../types.ts").EmailMessage) => DkimSignerOptions | null)
}

const DRIVER = "smtp"

const smtp: DriverFactory<SmtpDriverOptions> = defineDriver<SmtpDriverOptions>((opts) => {
  if (!opts?.host) throw createRequiredError(DRIVER, "host")

  const secure = opts.secure ?? false
  const port = opts.port ?? (secure ? 465 : 587)
  const connectionOpts: ConnectionOptions = {
    host: opts.host,
    port,
    secure,
    requireTLS: opts.requireTLS,
    user: opts.user,
    password: opts.password,
    authMethod: opts.authMethod ?? "AUTO",
    getAccessToken: opts.getAccessToken,
    rejectUnauthorized: opts.rejectUnauthorized ?? true,
    tls: opts.tls,
    localName: opts.localName ?? resolveLocalName(),
    connectionTimeoutMs: opts.connectionTimeoutMs ?? 30_000,
    commandTimeoutMs: opts.commandTimeoutMs ?? 10_000,
  }

  const poolOpts: PoolOptions = {
    enabled: opts.pool ?? false,
    maxConnections: opts.maxConnections ?? 5,
    maxMessagesPerConnection: opts.maxMessagesPerConnection ?? 0,
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    disposeGraceMs: opts.disposeGraceMs ?? 10_000,
    connection: connectionOpts,
  }

  let pool: ConnectionPool | null = null
  function getPool(): ConnectionPool {
    pool ??= createPool(poolOpts)
    return pool
  }

  return {
    name: DRIVER,
    options: opts,
    flags: {
      attachments: true,
      html: true,
      text: true,
      customHeaders: true,
      replyTo: true,
    },

    async dispose() {
      if (pool) await pool.dispose()
      pool = null
    },

    async send(msg) {
      try {
        const messageId = msg.headers?.["Message-ID"] ?? generateMessageId(opts.host)
        const mime = buildMime(normalizeMimeInput(msg, messageId))
        if (mime.envelope.rcpt.length === 0)
          throw createError(DRIVER, "INVALID_OPTIONS", "at least one recipient is required")
        const dkimConfig = typeof opts.dkim === "function" ? opts.dkim(msg) : opts.dkim
        const body = dkimConfig ? await signDkim(mime.body, dkimConfig) : mime.body
        const conn = await getPool().acquire()
        let failed = false
        try {
          await conn.sendMessage(mime.envelope, body)
          const result: EmailResult = {
            id: messageId,
            driver: DRIVER,
            at: new Date(),
            provider: { capabilities: Array.from(conn.capabilities.authMethods) },
          }
          return { data: result, error: null }
        } catch (err) {
          failed = true
          const error = err instanceof EmailError ? err : toEmailError(DRIVER, err)
          return { data: null, error }
        } finally {
          await getPool()
            .release(conn, failed)
            .catch(() => {})
        }
      } catch (err) {
        return { data: null, error: err instanceof EmailError ? err : toEmailError(DRIVER, err) }
      }
    },
  }
})

export default smtp

function resolveLocalName(): string {
  const g = globalThis as { process?: { versions?: { node?: string } } }
  if (!g.process?.versions?.node) return "localhost"
  try {
    // Dynamic require keeps this file Workers-parseable.
    // eslint-disable-next-line ts/no-require-imports
    const os = (globalThis as any).require?.("node:os") as { hostname?: () => string } | undefined
    const host = os?.hostname?.()
    return host && /^[\w.-]+$/.test(host) ? host : "localhost.localdomain"
  } catch {
    return "localhost.localdomain"
  }
}

function generateMessageId(host: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const ts = Date.now().toString(36)
  return `<${ts}.${rand}@${host}>`
}
