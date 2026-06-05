import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailMessage,
  EmailResult,
  EmailTag,
  Result,
} from "../types.ts"
import { defineDriver } from "../_define.ts"
import { normalizeAddresses } from "../_normalize.ts"
import { createError, createRequiredError } from "../errors.ts"
import { httpJson } from "./_http.ts"

/** Mailtrap Email API driver — production sending and Email Sandbox testing
 *  with the same API token. Mirrors the official SDK env pattern:
 *  \`MAILTRAP_API_KEY\` → \`apiKey\`, \`MAILTRAP_USE_SANDBOX\` → \`sandbox\`,
 *  \`MAILTRAP_INBOX_ID\` → \`inboxId\`. */
export interface MailtrapDriverOptions {
  apiKey: string
  /** Production send API base. Default \`https://send.api.mailtrap.io\`. */
  endpoint?: string
  fetch?: typeof fetch
  /** Used when no \`tags\` entry has \`name: "category"\`. */
  defaultCategory?: string
  /** Mailtrap edge protection may block requests without a User-Agent. */
  userAgent?: string
  /** Default sandbox mode when \`msg.sandbox\` is unset. */
  sandbox?: boolean
  /** Sandbox inbox ID (from mailtrap.io/sandboxes/{id}). Required for sandbox sends. */
  inboxId?: number | string
  /** Sandbox API base. Default \`https://sandbox.api.mailtrap.io\`. */
  sandboxEndpoint?: string
}

interface MailtrapSendSuccess {
  success?: boolean
  message_ids?: string[]
  errors?: string[]
}

interface MailtrapBatchItemResponse {
  success?: boolean
  message_ids?: string[]
  errors?: string[]
}

interface MailtrapBatchSuccess {
  success?: boolean
  responses?: MailtrapBatchItemResponse[]
  errors?: string[]
}

const DRIVER = "mailtrap"
const DEFAULT_ENDPOINT = "https://send.api.mailtrap.io"
const DEFAULT_SANDBOX_ENDPOINT = "https://sandbox.api.mailtrap.io"

const mailtrap: DriverFactory<MailtrapDriverOptions> = defineDriver<MailtrapDriverOptions>(
  (options) => {
    if (!options?.apiKey) throw createRequiredError(DRIVER, "apiKey")

    const sendEndpoint = options.endpoint ?? DEFAULT_ENDPOINT
    const sandboxEndpoint = options.sandboxEndpoint ?? DEFAULT_SANDBOX_ENDPOINT
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== "function")
      throw createError(DRIVER, "INVALID_OPTIONS", "fetch is unavailable; pass `fetch` explicitly")

    const defaultCategory = options.defaultCategory ?? "transactional"
    const userAgent = options.userAgent ?? "unemail/mailtrap"

    const mailtrapHeaders = (): Record<string, string> => ({
      "api-token": options.apiKey,
      "user-agent": userAgent,
    })

    return {
      name: DRIVER,
      options,
      flags: {
        attachments: true,
        html: true,
        text: true,
        batch: true,
        templates: true,
        tagging: true,
        replyTo: true,
        customHeaders: true,
      },

      async isAvailable() {
        return Boolean(options.apiKey)
      },

      async send(msg) {
        const unsupported = rejectUnsupported(msg)
        if (unsupported) return unsupported

        const useSandbox = resolveSandboxMode(msg, options)
        const inboxErr = requireInboxIdForSandbox(useSandbox, options)
        if (inboxErr) return inboxErr as Result<EmailResult>

        const payload = buildPayload(msg, defaultCategory)
        const res = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: resolveApiUrl(useSandbox, "send", options, sendEndpoint, sandboxEndpoint),
          headers: mailtrapHeaders(),
          body: payload,
          classifyError: classifyMailtrapError,
        })
        if (res.error) return res as Result<EmailResult>
        return parseSendSuccess(res.data)
      },

      async sendBatch(msgs) {
        if (msgs.length === 0) return { data: [], error: null }
        for (const msg of msgs) {
          const unsupported = rejectUnsupported(msg)
          if (unsupported) return unsupported as Result<ReadonlyArray<EmailResult>>
        }

        const mixed = validateBatchSandboxModes(msgs, options)
        if (mixed) return mixed as Result<ReadonlyArray<EmailResult>>

        const useSandbox = resolveSandboxMode(msgs[0]!, options)
        const inboxErr = requireInboxIdForSandbox(useSandbox, options)
        if (inboxErr) return inboxErr as Result<ReadonlyArray<EmailResult>>

        const payload = {
          requests: msgs.map((m) => buildPayload(m, defaultCategory)),
        }
        const res = await httpJson({
          fetch: fetchImpl,
          driver: DRIVER,
          url: resolveApiUrl(useSandbox, "batch", options, sendEndpoint, sandboxEndpoint),
          headers: mailtrapHeaders(),
          body: payload,
          classifyError: classifyMailtrapError,
        })
        if (res.error) return res as never

        const body = (res.data ?? {}) as MailtrapBatchSuccess
        if (body.success === false) {
          return {
            data: null,
            error: createError(
              DRIVER,
              "PROVIDER",
              formatErrors(body.errors) ?? "batch request failed",
              { cause: body },
            ),
          }
        }

        const responses = body.responses ?? []
        for (let i = 0; i < responses.length; i++) {
          const item = responses[i]
          if (item?.success === false) {
            return {
              data: null,
              error: createError(
                DRIVER,
                "PROVIDER",
                formatErrors(item.errors) || `batch item ${i} failed`,
                { cause: item },
              ),
            }
          }
        }

        const results: EmailResult[] = responses.map((item, i) => ({
          id: item?.message_ids?.[0] ?? `mailtrap_${Date.now().toString(36)}_${i}`,
          driver: DRIVER,
          at: new Date(),
          provider: item as unknown as Record<string, unknown>,
        }))
        return { data: results, error: null }
      },
    }
  },
)

export default mailtrap

function resolveSandboxMode(msg: EmailMessage, options: MailtrapDriverOptions): boolean {
  return msg.sandbox ?? options.sandbox ?? false
}

function isValidInboxId(inboxId: number | string | undefined): boolean {
  if (inboxId === undefined || inboxId === null) return false
  if (typeof inboxId === "number") return true
  return String(inboxId).trim().length > 0
}

function requireInboxIdForSandbox(
  useSandbox: boolean,
  options: MailtrapDriverOptions,
): Result<null> | null {
  if (!useSandbox) return null
  if (!isValidInboxId(options.inboxId)) {
    return {
      data: null,
      error: createError(
        DRIVER,
        "INVALID_OPTIONS",
        "`inboxId` is required for Mailtrap Email Sandbox",
        { retryable: false },
      ),
    }
  }
  return null
}

function resolveApiUrl(
  useSandbox: boolean,
  kind: "send" | "batch",
  options: MailtrapDriverOptions,
  sendEndpoint: string,
  sandboxEndpoint: string,
): string {
  const host = useSandbox ? sandboxEndpoint : sendEndpoint
  const suffix = useSandbox && isValidInboxId(options.inboxId) ? `/${options.inboxId}` : ""
  return `${host}/api/${kind}${suffix}`
}

function validateBatchSandboxModes(
  msgs: ReadonlyArray<EmailMessage>,
  options: MailtrapDriverOptions,
): Result<null> | null {
  if (msgs.length === 0) return null
  const first = resolveSandboxMode(msgs[0]!, options)
  for (let i = 1; i < msgs.length; i++) {
    if (resolveSandboxMode(msgs[i]!, options) !== first) {
      return {
        data: null,
        error: createError(
          DRIVER,
          "INVALID_OPTIONS",
          "mixed sandbox and production messages in one batch",
          { retryable: false },
        ),
      }
    }
  }
  return null
}

function rejectUnsupported(msg: EmailMessage): Result<EmailResult> | null {
  if (msg.scheduledAt) {
    return {
      data: null,
      error: createError(DRIVER, "UNSUPPORTED", "scheduling is not supported by Mailtrap", {
        retryable: false,
      }),
    }
  }
  return null
}

function parseSendSuccess(data: unknown): Result<EmailResult> {
  const body = (data ?? {}) as MailtrapSendSuccess
  if (body.success === false) {
    return {
      data: null,
      error: createError(DRIVER, "PROVIDER", formatErrors(body.errors) ?? "send failed", {
        cause: body,
      }),
    }
  }
  const id = body.message_ids?.[0] ?? `mailtrap_${Date.now().toString(36)}`
  return {
    data: {
      id,
      driver: DRIVER,
      at: new Date(),
      provider: body as Record<string, unknown>,
    },
    error: null,
  }
}

function classifyMailtrapError(
  status: number,
  body: unknown,
): {
  code: "AUTH" | "RATE_LIMIT" | "NETWORK" | "PROVIDER"
  retryable?: boolean
  message?: string
} | null {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null
  const errors = record?.errors
  const message =
    formatErrors(Array.isArray(errors) ? (errors as string[]) : undefined) ??
    (typeof record?.message === "string" ? record.message : null)

  if (status === 401 || status === 403) {
    return { code: "AUTH", retryable: false, message: message ?? undefined }
  }
  if (status === 429) {
    return { code: "RATE_LIMIT", retryable: true, message: message ?? undefined }
  }
  if (status >= 500) {
    return { code: "NETWORK", retryable: true, message: message ?? undefined }
  }
  if (message) return { code: "PROVIDER", retryable: false, message }
  return null
}

function formatErrors(errors: string[] | undefined): string | null {
  if (!errors?.length) return null
  return errors.join("; ")
}

function buildPayload(msg: EmailMessage, defaultCategory: string): Record<string, unknown> {
  const from = normalizeAddresses(msg.from)[0]
  if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")

  const payload: Record<string, unknown> = {
    from: toMailtrapAddress(from),
    to: normalizeAddresses(msg.to).map(toMailtrapAddress),
    subject: msg.subject,
  }
  if (msg.cc) payload.cc = normalizeAddresses(msg.cc).map(toMailtrapAddress)
  if (msg.bcc) payload.bcc = normalizeAddresses(msg.bcc).map(toMailtrapAddress)
  if (msg.replyTo) {
    const r = normalizeAddresses(msg.replyTo)[0]
    if (r) payload.reply_to = toMailtrapAddress(r)
  }
  if (msg.text) payload.text = msg.text
  if (msg.html) payload.html = msg.html
  if (msg.headers) payload.headers = msg.headers
  if (msg.attachments?.length) payload.attachments = msg.attachments.map(toMailtrapAttachment)

  const customVars: Record<string, string> = {}
  if (msg.metadata) {
    for (const [k, v] of Object.entries(msg.metadata)) customVars[k] = String(v)
  }
  if (msg.tags?.length) {
    for (const tag of msg.tags) {
      if (tag.name === "category") continue
      customVars[`tag_${tag.name}`] = tag.value ?? ""
    }
  }
  if (Object.keys(customVars).length) payload.custom_variables = customVars

  payload.category = resolveCategory(msg.tags, defaultCategory)

  if (msg.template) {
    if (msg.template.id) payload.template_uuid = msg.template.id
    if (msg.template.variables) payload.template_variables = { ...msg.template.variables }
  }

  if (!msg.template && !msg.text && !msg.html) {
    throw createError(DRIVER, "INVALID_OPTIONS", "`text`, `html`, or `template` is required")
  }

  return payload
}

function resolveCategory(tags: ReadonlyArray<EmailTag> | undefined, fallback: string): string {
  const cat = tags?.find((t) => t.name === "category")
  if (cat?.value) return cat.value
  if (cat?.name === "category" && !cat.value) return fallback
  return fallback
}

function toMailtrapAddress(a: EmailAddress): Record<string, string> {
  return a.name ? { email: a.email, name: a.name } : { email: a.email }
}

function toMailtrapAttachment(a: Attachment): Record<string, unknown> {
  const content = typeof a.content === "string" ? a.content : bytesToBase64(a.content)
  const out: Record<string, unknown> = {
    content,
    filename: a.filename,
  }
  if (a.contentType) out.type = a.contentType
  if (a.disposition) out.disposition = a.disposition
  if (a.cid) out.content_id = a.cid
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
