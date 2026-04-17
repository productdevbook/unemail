import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailMessage,
  EmailResult,
  Result,
} from "../types.ts"
import { defineDriver } from "../_define.ts"
import { formatAddress, normalizeAddresses } from "../_normalize.ts"
import { createError, createRequiredError, toEmailError } from "../errors.ts"

/** Options for the Postmark driver. Postmark is the only mainstream
 *  provider with native transactional vs broadcast stream isolation —
 *  route by `msg.stream`, or set `messageStream` as a driver-level default. */
export interface PostmarkDriverOptions {
  /** Server API token (the per-server token, not the account token). */
  token: string
  /** Default \`MessageStream\` if the message doesn't specify \`stream\`. */
  messageStream?: string
  /** Override for self-hosted gateways or test stubs. */
  endpoint?: string
  /** Injected fetch — defaults to global \`fetch\`. */
  fetch?: typeof fetch
}

const DRIVER = "postmark"
const DEFAULT_ENDPOINT = "https://api.postmarkapp.com"

const postmark: DriverFactory<PostmarkDriverOptions> = defineDriver<PostmarkDriverOptions>(
  (options) => {
    if (!options?.token) throw createRequiredError(DRIVER, "token")
    const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== "function")
      throw createError(DRIVER, "INVALID_OPTIONS", "fetch is unavailable; pass `fetch` explicitly")

    return {
      name: DRIVER,
      options,
      flags: {
        attachments: true,
        html: true,
        text: true,
        batch: true,
        tracking: true,
        templates: true,
        tagging: true,
        replyTo: true,
        customHeaders: true,
      },

      async isAvailable() {
        return Boolean(options.token)
      },

      async send(msg) {
        const payload = buildPayload(msg, options.messageStream)
        const res = await request(fetchImpl, endpoint, "/email", "POST", options.token, payload)
        if (res.error) return res as Result<EmailResult>
        const body = res.data as PostmarkSendResponse
        const result: EmailResult = {
          id: body.MessageID,
          driver: DRIVER,
          stream: msg.stream ?? options.messageStream,
          at: parsePostmarkDate(body.SubmittedAt) ?? new Date(),
          provider: body as unknown as Record<string, unknown>,
        }
        return { data: result, error: null }
      },

      async sendBatch(msgs) {
        const payload = msgs.map((m) => buildPayload(m, options.messageStream))
        const res = await request(
          fetchImpl,
          endpoint,
          "/email/batch",
          "POST",
          options.token,
          payload,
        )
        if (res.error) return res as never
        const body = res.data as PostmarkSendResponse[]
        const failures = body.filter((entry) => (entry.ErrorCode ?? 0) !== 0)
        if (failures.length > 0) {
          const first = failures[0]!
          return {
            data: null,
            error: createError(
              DRIVER,
              "PROVIDER",
              first.Message ?? `batch partial failure (${failures.length}/${body.length})`,
              {
                status: first.ErrorCode,
                cause: body,
                retryable: false,
              },
            ),
          }
        }
        const results: EmailResult[] = body.map((entry, i) => ({
          id: entry.MessageID,
          driver: DRIVER,
          stream: msgs[i]?.stream ?? options.messageStream,
          at: parsePostmarkDate(entry.SubmittedAt) ?? new Date(),
          provider: entry as unknown as Record<string, unknown>,
        }))
        return { data: results, error: null }
      },
    }
  },
)

export default postmark

interface PostmarkSendResponse {
  MessageID: string
  SubmittedAt?: string
  To?: string
  ErrorCode?: number
  Message?: string
}

function buildPayload(msg: EmailMessage, defaultStream?: string): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const body: Record<string, unknown> = {
    From: formatAddress(from),
    To: addressList(msg.to),
    Subject: msg.subject,
  }
  if (msg.cc) body.Cc = addressList(msg.cc)
  if (msg.bcc) body.Bcc = addressList(msg.bcc)
  if (msg.replyTo) body.ReplyTo = addressList(msg.replyTo)
  if (msg.text) body.TextBody = msg.text
  if (msg.html) body.HtmlBody = msg.html
  if (msg.headers)
    body.Headers = Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value }))
  // Postmark treats Metadata as the metadata bag. Prefer msg.metadata; fall back to tags.
  if (msg.metadata) body.Metadata = { ...msg.metadata }
  else if (msg.tags?.length)
    body.Metadata = Object.fromEntries(msg.tags.map((t) => [t.name, t.value]))
  if (msg.tags?.length) body.Tag = msg.tags[0]!.name
  if (msg.tracking?.opens !== undefined) body.TrackOpens = msg.tracking.opens
  if (msg.tracking?.clicks !== undefined)
    body.TrackLinks = msg.tracking.clicks ? "HtmlAndText" : "None"
  if (msg.attachments?.length) body.Attachments = msg.attachments.map(toPostmarkAttachment)
  const stream = msg.stream ?? defaultStream
  if (stream) body.MessageStream = stream
  return body
}

function addressList(input: EmailMessage["to"]): string {
  return normalizeAddresses(input)
    .map((a: EmailAddress) => formatAddress(a))
    .join(", ")
}

function toPostmarkAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  const out: Record<string, unknown> = {
    Name: a.filename,
    Content: content,
    ContentType: a.contentType ?? "application/octet-stream",
  }
  if (a.cid) out.ContentID = `cid:${a.cid}`
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as {
    Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function parsePostmarkDate(value?: string): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

async function request(
  fetchImpl: typeof fetch,
  endpoint: string,
  path: string,
  method: string,
  token: string,
  body: unknown,
): Promise<Result<unknown>> {
  let res: Response
  try {
    res = await fetchImpl(`${endpoint}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-postmark-server-token": token,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { data: null, error: toEmailError(DRIVER, err) }
  }

  const text = await res.text()
  const parsed = text ? safeJson(text) : null

  if (!res.ok) {
    const apiError = (parsed ?? {}) as { Message?: string; ErrorCode?: number }
    const code =
      res.status === 401 || res.status === 403 || apiError.ErrorCode === 10
        ? "AUTH"
        : res.status === 429
          ? "RATE_LIMIT"
          : res.status >= 500
            ? "NETWORK"
            : "PROVIDER"
    return {
      data: null,
      error: createError(DRIVER, code, apiError.Message ?? `HTTP ${res.status}`, {
        status: res.status,
        cause: { headers: res.headers, body: parsed ?? text },
        retryable: code === "RATE_LIMIT" || code === "NETWORK",
      }),
    }
  }

  return { data: parsed, error: null }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
