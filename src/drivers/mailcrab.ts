import type {
  DriverWithInstance,
  EmailResult,
  NormalizedMessage,
  Result,
  SendContext,
  SendStatus,
} from "../core/types.ts"
import type { SmtpOptions } from "./smtp.ts"
import { defineDriver } from "../core/define.ts"
import { createError } from "../core/error.ts"
import { getHeader } from "../core/message.ts"
import { err, ok } from "../core/result.ts"
import { httpJson, resolveFetch } from "./_fetch.ts"
import smtp from "./smtp.ts"

export interface MailcrabOptions {
  /** Default: `localhost`. */
  host?: string
  /** Mailcrab's SMTP port (`SMTP_PORT`). Default: 1025. */
  port?: number
  /** Mailcrab's HTTP port (`HTTP_PORT`). Default: 1080. */
  httpPort?: number
  /** Full base URL of the HTTP API, when it is not `http://host:httpPort` —
   *  behind a reverse proxy, or in a test. */
  httpEndpoint?: string
  /** Mailcrab's `MAILCRAB_PREFIX`, which moves every route — `/ws` and
   *  `/api/*` alike — under `/{prefix}`. */
  prefix?: string
  /** Set when Mailcrab runs with `ENABLE_TLS_AUTH=true`, which turns on
   *  implicit TLS on the SMTP port. Not STARTTLS. Default: false. */
  secure?: boolean
  /** Mailcrab accepts any credentials once `ENABLE_TLS_AUTH=true`; these
   *  exist so code under test can exercise its real auth path. */
  user?: string
  password?: string
  /** Keep SMTP connections open between sends. Default: false. */
  pool?: boolean
  /** Default: 5_000 — a tenth of the SMTP driver's, because a local
   *  catcher that is not running should fail now rather than in half a
   *  minute. */
  connectionTimeoutMs?: number
  /** Default: 5_000. */
  commandTimeoutMs?: number
  /** Abort an inbox request after this long, in milliseconds. Default:
   *  10_000. */
  timeoutMs?: number
  /** Injected fetch, for the inbox. Defaults to the global. */
  fetch?: typeof fetch
}

const DRIVER = "mailcrab"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A name and address as Mailcrab parsed them; either half may be absent
 *  when the header did not carry it. */
export interface MailcrabAddress {
  readonly name?: string | null
  readonly email?: string | null
}

/** Mailcrab reports `size` as a pre-formatted string (`"1.2 kB"`), not a
 *  byte count, and never includes attachment bytes in JSON. */
export interface MailcrabAttachment {
  readonly filename: string
  readonly mime: string
  readonly size: string
  readonly content_id?: string | null
}

interface MailcrabCommon {
  readonly id: string
  readonly from: MailcrabAddress
  readonly to: readonly MailcrabAddress[]
  readonly subject: string
  readonly time: number
  readonly date: string
  readonly size: string
  readonly opened: boolean
  readonly attachments: readonly MailcrabAttachment[]
  readonly envelope_from: string
  readonly envelope_recipients: readonly string[]
  readonly parse_warnings?: readonly string[]
}

/** What `GET /api/messages` lists: no bodies and no headers. */
export interface MailcrabSummary extends MailcrabCommon {
  readonly has_html: boolean
  readonly has_plain: boolean
}

/** What `GET /api/message/{id}` returns. */
export interface MailcrabMessage extends MailcrabCommon {
  readonly headers: Readonly<Record<string, string>>
  readonly text: string
  readonly html: string
}

/** The captured mailbox, also returned by `driver.getInstance()`. Every
 *  call is a request to the running Mailcrab, so each returns a `Result`
 *  rather than throwing. */
export interface MailcrabInbox {
  /** Every captured message, newest first. */
  list: () => Promise<Result<readonly MailcrabSummary[]>>
  get: (id: string) => Promise<Result<MailcrabMessage>>
  /** Messages addressed to `address`. Mailcrab parses only `From` and
   *  `To`, so a Cc or Bcc recipient is matched against the SMTP envelope
   *  instead — which is the only place it appears. */
  find: (address: string) => Promise<Result<readonly MailcrabSummary[]>>
  /** The most recent message in full, or `null` on an empty inbox. */
  last: () => Promise<Result<MailcrabMessage | null>>
  /** Look a message up by the `Message-ID` that `send()` returned. */
  byMessageId: (messageId: string) => Promise<Result<MailcrabMessage | null>>
  delete: (id: string) => Promise<Result<void>>
  clear: () => Promise<Result<void>>
  /** Mailcrab's backend version, which doubles as a liveness check. */
  version: () => Promise<Result<string>>
}

/**
 * Mailcrab — the local SMTP catcher — as correct defaults plus an inbox
 * you can assert against.
 *
 * Sending is the `smtp` driver pointed at `localhost:1025` with no auth
 * and no TLS, which is how Mailcrab listens out of the box. Reading is its
 * HTTP API on port 1080, exposed as `driver.getInstance()`, so a test can
 * check what was actually captured instead of trusting that a send
 * resolved.
 *
 * ```ts
 * const driver = mailcrab()
 * const email = createEmail({ driver, defaults: { from: "dev@acme.com" } })
 * await email.send({ to: "ada@example.com", subject: "hi", text: "hello" })
 * const { data } = await driver.getInstance().last()
 * expect(data?.subject).toBe("hi")
 * ```
 */
const mailcrab: (options?: MailcrabOptions) => DriverWithInstance<MailcrabInbox> = defineDriver<
  MailcrabOptions | void,
  MailcrabInbox
>((options) => {
  const opts = options || {}
  const host = opts.host ?? "localhost"
  const secure = opts.secure ?? false
  const fetchImpl = resolveFetch(DRIVER, opts.fetch)
  const base = `${opts.httpEndpoint ?? `http://${host}:${opts.httpPort ?? 1080}`}`.replace(
    /\/$/,
    "",
  )
  const prefix = opts.prefix ? `/${opts.prefix.replace(/^\/|\/$/g, "")}` : ""

  const transport = smtp({
    host,
    port: opts.port ?? 1025,
    secure,
    // The certificate Mailcrab generates for `ENABLE_TLS_AUTH` is
    // self-signed, so verifying it would refuse every connection.
    rejectUnauthorized: false,
    ...(opts.user == null ? {} : { user: opts.user }),
    ...(opts.password == null ? {} : { password: opts.password }),
    pool: opts.pool ?? false,
    connectionTimeoutMs: opts.connectionTimeoutMs ?? 5_000,
    commandTimeoutMs: opts.commandTimeoutMs ?? 5_000,
  } satisfies SmtpOptions)

  function api(path: string, method: "GET" | "POST" = "GET"): Promise<Result<unknown>> {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: `${base}${prefix}${path}`,
      method,
      timeoutMs: opts.timeoutMs ?? 10_000,
    })
  }

  const inbox: MailcrabInbox = {
    async list() {
      const response = await api("/api/messages")
      if (response.error) return err(response.error)
      const messages = (response.data ?? []) as MailcrabSummary[]
      return ok([...messages].sort((a, b) => b.time - a.time))
    },

    async get(id) {
      const response = await api(`/api/message/${encodeURIComponent(id)}`)
      if (response.error) return err(response.error)
      return ok(response.data as MailcrabMessage)
    },

    async find(address) {
      const listed = await inbox.list()
      if (listed.error) return err(listed.error)
      const target = address.toLowerCase()
      return ok(
        listed.data.filter(
          (message) =>
            message.to.some((a) => a.email?.toLowerCase() === target) ||
            message.envelope_recipients.some((a) => a.toLowerCase() === target),
        ),
      )
    },

    async last() {
      const listed = await inbox.list()
      if (listed.error) return err(listed.error)
      const newest = listed.data[0]
      if (!newest) return ok(null)
      return inbox.get(newest.id)
    },

    async byMessageId(messageId) {
      const listed = await inbox.list()
      if (listed.error) return err(listed.error)
      // The listing carries no headers, so the only way to match the id
      // an SMTP send returned is to open each message. Newest first, since
      // a caller looking one up almost always just sent it.
      for (const summary of listed.data) {
        const full = await inbox.get(summary.id)
        if (full.error) return err(full.error)
        if (getHeader(full.data.headers, "message-id") === messageId) return ok(full.data)
      }
      return ok(null)
    },

    async delete(id) {
      const response = await api(`/api/delete/${encodeURIComponent(id)}`, "POST")
      return response.error ? err(response.error) : ok(undefined)
    },

    async clear() {
      const response = await api("/api/delete-all", "POST")
      return response.error ? err(response.error) : ok(undefined)
    },

    async version() {
      const response = await api("/api/version")
      if (response.error) return err(response.error)
      return ok(String((response.data as { version_be?: string })?.version_be ?? ""))
    },
  }

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      replyTo: true,
      customHeaders: true,
      // Nothing Mailcrab accepts is ever delivered, so a message asking to
      // be sandboxed is asking for what this driver already does.
      sandbox: true,
      retrievable: true,
    },

    getInstance: () => inbox,

    initialize: () => transport.initialize?.(),
    dispose: () => transport.dispose?.(),

    async isAvailable() {
      return !(await inbox.version()).error
    },

    async send(msg: NormalizedMessage, ctx: SendContext): Promise<Result<EmailResult>> {
      const result = await transport.send(msg, ctx)
      if (result.error) return err(result.error)
      return ok({ ...result.data, driver: DRIVER })
    },

    async retrieve(id: string): Promise<Result<SendStatus>> {
      const found = UUID.test(id) ? await inbox.get(id) : await inbox.byMessageId(id)
      if (found.error) return err(found.error)
      if (!found.data) {
        return err(createError(DRIVER, "PROVIDER", `no captured message with Message-ID ${id}`))
      }
      const status: SendStatus = {
        id: found.data.id,
        driver: DRIVER,
        // A catcher accepts or it does not; there is no later state.
        state: "delivered",
        at: new Date(found.data.time * 1000),
        provider: found.data as unknown as Record<string, unknown>,
      }
      return ok(status)
    },
  }
})

export default mailcrab
