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
import { hasHeader, patchMessage } from "../core/message.ts"
import { err, ok } from "../core/result.ts"
import { stringToBase64 } from "./_base64.ts"
import { httpBytes, httpJson, httpText, resolveFetch } from "./_fetch.ts"
import smtp from "./smtp.ts"

export interface MailpitOptions {
  /** Default: `localhost`. */
  host?: string
  /** Mailpit's SMTP port (`--smtp`). Default: 1025. */
  port?: number
  /** Mailpit's HTTP port (`--listen`). Default: 8025. */
  httpPort?: number
  /** Full base URL of the HTTP API, when it is not `http://host:httpPort` —
   *  behind a reverse proxy, or in a test. */
  httpEndpoint?: string
  /** Mailpit's `--webroot`, which moves every route — the UI and `/api/*`
   *  alike — under `/{webroot}`. */
  webroot?: string
  /** Set when Mailpit runs with `--smtp-tls-cert`, which turns on implicit
   *  TLS on the SMTP port. Not STARTTLS. Default: false. */
  secure?: boolean
  /** Credentials for `--smtp-auth`. Mailpit accepts any pair under
   *  `--smtp-auth-accept-any`, so these exist mainly so code under test can
   *  exercise its real auth path. */
  user?: string
  password?: string
  /** Credentials for `--ui-auth`, the basic auth that covers the web UI and
   *  the whole API. Unrelated to the SMTP credentials above. */
  apiUser?: string
  apiPassword?: string
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

const DRIVER = "mailpit"

/** A parsed address. `Name` is `""` when the header carried only an
 *  address. */
export interface MailpitAddress {
  readonly Name: string
  readonly Address: string
}

/** An attachment or inline part. The bytes are not in the JSON; read them
 *  with `inbox.attachment(id, PartID)`. */
export interface MailpitAttachment {
  readonly PartID: string
  readonly FileName: string
  readonly ContentType: string
  readonly ContentID: string
  readonly Size: number
  readonly Checksums?: {
    readonly MD5?: string
    readonly SHA1?: string
    readonly SHA256?: string
  }
}

/** What `GET /api/v1/messages` and `GET /api/v1/search` list. No bodies,
 *  and `Attachments` is a count rather than the parts themselves. */
export interface MailpitSummary {
  readonly ID: string
  /** The `Message-ID` header with its angle brackets stripped. */
  readonly MessageID: string
  readonly Read: boolean
  readonly From: MailpitAddress | null
  readonly To: readonly MailpitAddress[]
  readonly Cc: readonly MailpitAddress[]
  readonly Bcc: readonly MailpitAddress[]
  readonly ReplyTo: readonly MailpitAddress[]
  readonly Subject: string
  readonly Created: string
  readonly Size: number
  readonly Attachments: number
  readonly Snippet: string
  readonly Tags: readonly string[]
  readonly Username?: string
}

/** What `GET /api/v1/message/{id}` returns. */
export interface MailpitMessage {
  readonly ID: string
  readonly MessageID: string
  readonly From: MailpitAddress | null
  readonly To: readonly MailpitAddress[]
  readonly Cc: readonly MailpitAddress[]
  readonly Bcc: readonly MailpitAddress[]
  readonly ReplyTo: readonly MailpitAddress[]
  readonly Subject: string
  /** The `Date` header when the message set one, else when it arrived. */
  readonly Date: string
  readonly Text: string
  readonly HTML: string
  readonly Size: number
  readonly Attachments: readonly MailpitAttachment[]
  readonly Inline: readonly MailpitAttachment[]
  readonly Tags: readonly string[]
  readonly ReturnPath: string
  readonly ListUnsubscribe?: {
    readonly Header: string
    readonly HeaderPost: string
    readonly Links: readonly string[]
    readonly Errors: string
  }
  readonly Username?: string
}

/** One client's verdict on one HTML or CSS feature. */
export interface MailpitHtmlCheckResult {
  /** `Outlook`, `Mozilla Thunderbird`, `Apple Mail`… */
  readonly Family: string
  readonly Platform: string
  readonly Version: string
  /** `yes`, `no` or `partial`. */
  readonly Support: string
  readonly Name: string
  readonly NoteNumber: string
}

/** One feature the message uses that some client does not support. */
export interface MailpitHtmlCheckWarning {
  readonly Slug: string
  readonly Title: string
  readonly Description: string
  /** `css` or `html`. */
  readonly Category: string
  readonly URL: string
  readonly Tags: readonly string[]
  readonly Keywords: string
  readonly NotesByNumber: Readonly<Record<string, string>>
  readonly Results: readonly MailpitHtmlCheckResult[]
  readonly Score: {
    readonly Found: number
    readonly Supported: number
    readonly Partial: number
    readonly Unsupported: number
  }
}

/** `GET /api/v1/message/{id}/html-check`: how well the message's HTML is
 *  supported across the clients caniemail.com tracks. */
export interface MailpitHtmlCheck {
  readonly Total: {
    readonly Nodes: number
    readonly Tests: number
    readonly Supported: number
    readonly Partial: number
    readonly Unsupported: number
  }
  readonly Warnings: readonly MailpitHtmlCheckWarning[]
  readonly Platforms: Readonly<Record<string, readonly string[]>>
}

/** `GET /api/v1/info`. */
export interface MailpitInfo {
  readonly Version: string
  readonly LatestVersion: string
  readonly Database: string
  readonly DatabaseSize: number
  readonly Messages: number
  readonly Unread: number
  readonly Tags: Readonly<Record<string, number>>
  readonly RuntimeStats: {
    readonly Uptime: number
    readonly Memory: number
    readonly MessagesDeleted: number
    readonly SMTPAccepted: number
    readonly SMTPAcceptedSize: number
    readonly SMTPIgnored: number
    readonly SMTPRejected: number
  }
}

export interface MailpitListOptions {
  /** Pagination offset. Default: 0. */
  start?: number
  /** Default: 50, which is Mailpit's own. */
  limit?: number
  /** IANA timezone name, used only to resolve `before:` and `after:` terms
   *  in a search. */
  tz?: string
}

/** The captured mailbox, also returned by `driver.getInstance()`. Every
 *  call is a request to the running Mailpit, so each returns a `Result`
 *  rather than throwing. */
export interface MailpitInbox {
  /** Every captured message, newest first. */
  list: (options?: MailpitListOptions) => Promise<Result<readonly MailpitSummary[]>>
  /** Full-text search over the mailbox, newest first. The query language
   *  is Mailpit's own: `to:`, `from:`, `cc:`, `bcc:`, `subject:`,
   *  `message-id:`, `tag:`, `is:read`, `has:attachment`, `before:`,
   *  `after:`, bare words, and any of those negated with `-`.
   *  https://mailpit.axllent.org/docs/usage/search-filters/ */
  search: (
    query: string,
    options?: MailpitListOptions,
  ) => Promise<Result<readonly MailpitSummary[]>>
  /** One message in full. `id` may be `latest`. */
  get: (id: string) => Promise<Result<MailpitMessage>>
  /** Messages with `address` among their To, Cc or Bcc. */
  find: (address: string) => Promise<Result<readonly MailpitSummary[]>>
  /** The most recent message in full, or `null` on an empty inbox. */
  last: () => Promise<Result<MailpitMessage | null>>
  /** Look a message up by the `Message-ID` that `send()` returned. */
  byMessageId: (messageId: string) => Promise<Result<MailpitMessage | null>>
  /** The message as it arrived: RFC 5322 source, headers and all. */
  raw: (id: string) => Promise<Result<string>>
  /** Every header, as a list of values per name. */
  headers: (id: string) => Promise<Result<Readonly<Record<string, readonly string[]>>>>
  /** An attachment's bytes, addressed by the `PartID` on the message. */
  attachment: (id: string, partId: string) => Promise<Result<Uint8Array>>
  /** Score the message's HTML against real client support. Mailpit
   *  answers 400 for a message with no HTML part. */
  htmlCheck: (id: string) => Promise<Result<MailpitHtmlCheck>>
  /** Every tag in use across the mailbox. */
  tags: () => Promise<Result<readonly string[]>>
  /** Replace the tags on each of `ids`. An empty `tags` clears them. */
  setTags: (ids: readonly string[], tags: readonly string[]) => Promise<Result<void>>
  delete: (ids: string | readonly string[]) => Promise<Result<void>>
  clear: () => Promise<Result<void>>
  info: () => Promise<Result<MailpitInfo>>
  /** Mailpit's version, which doubles as a liveness check. */
  version: () => Promise<Result<string>>
}

/**
 * Mailpit — the local SMTP catcher Laravel Sail and DDEV ship — as correct
 * defaults plus an inbox you can assert against.
 *
 * Sending is the `smtp` driver pointed at `localhost:1025` with no auth and
 * no TLS, which is how Mailpit listens out of the box. Reading is its API
 * on port 8025, exposed as `driver.getInstance()`, so a test can check what
 * was actually captured instead of trusting that a send resolved.
 *
 * ```ts
 * const driver = mailpit()
 * const email = createEmail({ driver, defaults: { from: "dev@acme.com" } })
 * await email.send({ to: "ada@example.com", subject: "hi", html: "<p>hello</p>" })
 *
 * const inbox = driver.getInstance()
 * const { data } = await inbox.last()
 * expect(data?.Subject).toBe("hi")
 *
 * // Nothing else here can answer this: does the template survive Outlook?
 * const { data: check } = await inbox.htmlCheck(data!.ID)
 * expect(check!.Total.Unsupported).toBe(0)
 * ```
 */
const mailpit: (options?: MailpitOptions) => DriverWithInstance<MailpitInbox> = defineDriver<
  MailpitOptions | void,
  MailpitInbox
>((options) => {
  const opts = options || {}
  const host = opts.host ?? "localhost"
  const fetchImpl = resolveFetch(DRIVER, opts.fetch)
  const base = `${opts.httpEndpoint ?? `http://${host}:${opts.httpPort ?? 8025}`}`.replace(
    /\/$/,
    "",
  )
  const webroot = opts.webroot ? `/${opts.webroot.replace(/^\/|\/$/g, "")}` : ""
  const timeoutMs = opts.timeoutMs ?? 10_000
  const headers: Record<string, string> =
    opts.apiUser == null && opts.apiPassword == null
      ? {}
      : {
          authorization: `Basic ${stringToBase64(`${opts.apiUser ?? ""}:${opts.apiPassword ?? ""}`)}`,
        }

  const transport = smtp({
    host,
    port: opts.port ?? 1025,
    secure: opts.secure ?? false,
    // The certificate Mailpit generates for its TLS listener is self-signed,
    // so verifying it would refuse every connection.
    rejectUnauthorized: false,
    ...(opts.user == null ? {} : { user: opts.user }),
    ...(opts.password == null ? {} : { password: opts.password }),
    pool: opts.pool ?? false,
    connectionTimeoutMs: opts.connectionTimeoutMs ?? 5_000,
    commandTimeoutMs: opts.commandTimeoutMs ?? 5_000,
  } satisfies SmtpOptions)

  function url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value != null) search.set(key, String(value))
    }
    const qs = search.toString()
    return `${base}${webroot}${path}${qs ? `?${qs}` : ""}`
  }

  interface Call {
    method?: string
    query?: Record<string, string | number | undefined>
    body?: unknown
  }

  function api(path: string, call: Call = {}): Promise<Result<unknown>> {
    return httpJson({
      fetch: fetchImpl,
      driver: DRIVER,
      url: url(path, call.query),
      method: call.method ?? "GET",
      headers,
      ...(call.body === undefined ? {} : { body: call.body }),
      timeoutMs,
    })
  }

  async function summaries(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<Result<readonly MailpitSummary[]>> {
    const response = await api(path, { query })
    if (response.error) return err(response.error)
    const body = (response.data ?? {}) as { messages?: MailpitSummary[] }
    // Mailpit orders by received date descending itself; no sort here.
    return ok(body.messages ?? [])
  }

  const inbox: MailpitInbox = {
    list(listOptions) {
      return summaries("/api/v1/messages", {
        start: listOptions?.start,
        limit: listOptions?.limit,
      })
    },

    search(query, listOptions) {
      return summaries("/api/v1/search", {
        query,
        start: listOptions?.start,
        limit: listOptions?.limit,
        tz: listOptions?.tz,
      })
    },

    async get(id) {
      const response = await api(`/api/v1/message/${encodeURIComponent(id)}`)
      if (response.error) return err(response.error)
      return ok(response.data as MailpitMessage)
    },

    async find(address) {
      // `addressed:` is the only single term covering every recipient
      // field, but it matches From and Reply-To too — and by substring,
      // since Mailpit searches the stored JSON with LIKE. Narrow it here.
      const found = await inbox.search(`addressed:${address}`)
      if (found.error) return err(found.error)
      const target = address.toLowerCase()
      return ok(
        found.data.filter((message) =>
          [...message.To, ...message.Cc, ...message.Bcc].some(
            (a) => a.Address.toLowerCase() === target,
          ),
        ),
      )
    },

    async last() {
      const found = await inbox.get("latest")
      // An empty mailbox has no `latest`, which is an answer rather than a
      // failure.
      if (found.error) return found.error.status === 404 ? ok(null) : err(found.error)
      return ok(found.data)
    },

    async byMessageId(messageId) {
      // Mailpit stores the Message-ID with its angle brackets stripped, and
      // matches it with LIKE, so the search returns a superset.
      const bare = messageId.replace(/^<|>$/g, "")
      const found = await inbox.search(`message-id:${bare}`)
      if (found.error) return err(found.error)
      const match = found.data.find((message) => message.MessageID === bare)
      if (!match) return ok(null)
      return inbox.get(match.ID)
    },

    raw(id) {
      return httpText({
        fetch: fetchImpl,
        driver: DRIVER,
        url: url(`/api/v1/message/${encodeURIComponent(id)}/raw`),
        method: "GET",
        headers,
        timeoutMs,
      })
    },

    async headers(id) {
      const response = await api(`/api/v1/message/${encodeURIComponent(id)}/headers`)
      if (response.error) return err(response.error)
      return ok((response.data ?? {}) as Record<string, readonly string[]>)
    },

    attachment(id, partId) {
      return httpBytes({
        fetch: fetchImpl,
        driver: DRIVER,
        url: url(`/api/v1/message/${encodeURIComponent(id)}/part/${encodeURIComponent(partId)}`),
        method: "GET",
        headers,
        timeoutMs,
      })
    },

    async htmlCheck(id) {
      const response = await api(`/api/v1/message/${encodeURIComponent(id)}/html-check`)
      if (response.error) return err(response.error)
      return ok(response.data as MailpitHtmlCheck)
    },

    async tags() {
      const response = await api("/api/v1/tags")
      if (response.error) return err(response.error)
      return ok((response.data ?? []) as readonly string[])
    },

    async setTags(ids, tags) {
      if (ids.length === 0) return ok(undefined)
      const response = await api("/api/v1/tags", {
        method: "PUT",
        body: { IDs: [...ids], Tags: [...tags] },
      })
      return response.error ? err(response.error) : ok(undefined)
    },

    async delete(ids) {
      const list = typeof ids === "string" ? [ids] : ids
      // Mailpit reads an empty or absent `IDs` as "delete everything", so
      // deleting nothing has to mean sending nothing.
      if (list.length === 0) return ok(undefined)
      const response = await api("/api/v1/messages", {
        method: "DELETE",
        body: { IDs: [...list] },
      })
      return response.error ? err(response.error) : ok(undefined)
    },

    async clear() {
      const response = await api("/api/v1/messages", { method: "DELETE" })
      return response.error ? err(response.error) : ok(undefined)
    },

    async info() {
      const response = await api("/api/v1/info")
      if (response.error) return err(response.error)
      return ok(response.data as MailpitInfo)
    },

    async version() {
      const found = await inbox.info()
      if (found.error) return err(found.error)
      return ok(String(found.data?.Version ?? ""))
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
      // Mailpit reads `X-Tags` off the message itself, so a tag survives
      // the SMTP hop and `search("tag:...")` can find it again.
      tagging: true,
      // Nothing Mailpit accepts is ever delivered, so a message asking to
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
      const result = await transport.send(withTags(msg), ctx)
      if (result.error) return err(result.error)
      return ok({ ...result.data, driver: DRIVER })
    },

    async retrieve(id: string): Promise<Result<SendStatus>> {
      const found = looksLikeMessageId(id) ? await inbox.byMessageId(id) : await inbox.get(id)
      if (found.error) return err(found.error)
      if (!found.data) {
        return err(createError(DRIVER, "PROVIDER", `no captured message with Message-ID ${id}`))
      }
      const status: SendStatus = {
        id: found.data.ID,
        driver: DRIVER,
        // A catcher accepts or it does not; there is no later state.
        state: "delivered",
        at: new Date(found.data.Date),
        provider: found.data as unknown as Record<string, unknown>,
      }
      return ok(status)
    },
  }
})

export default mailpit

/** Mailpit's own ids are shortuuids, which carry neither character. */
function looksLikeMessageId(id: string): boolean {
  return id.includes("@") || id.startsWith("<")
}

/** Mailpit tags a message from a comma-separated `X-Tags` header. Tag
 *  values have nowhere to go there, so they follow the house convention of
 *  a header each. */
function withTags(msg: NormalizedMessage): NormalizedMessage {
  if (msg.tags.length === 0 || hasHeader(msg.headers, "x-tags")) return msg
  const headers: Record<string, string> = { ...msg.headers }
  headers["X-Tags"] = msg.tags.map((tag) => tag.name).join(",")
  for (const tag of msg.tags) {
    if (tag.value) headers[`X-Tag-${tag.name}`] = tag.value
  }
  return patchMessage(msg, { headers })
}
