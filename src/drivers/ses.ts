import type { DriverFactory, EmailMessage, EmailResult, Result } from "../types.ts"
import type { AwsCredentials } from "./_ses/sigv4.ts"
import { defineDriver } from "../_define.ts"
import { createError, createRequiredError, toEmailError } from "../errors.ts"
import { buildMime, normalizeMimeInput } from "./_smtp/mime.ts"
import { signRequest } from "./_ses/sigv4.ts"

/** Options for the AWS SES v2 driver. Zero-dep: no \`@aws-sdk/*\` imports,
 *  Web Crypto SigV4, raw MIME via our shared builder (so attachments and
 *  inline content work). Targets the SES v2 public API endpoint
 *  \`email.{region}.amazonaws.com\`. */
export interface SesDriverOptions {
  region: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** Optional: SES Configuration Set used for event routing. */
  configurationSetName?: string
  /** Optional: FromEmailAddressIdentityArn / ReturnPath helpers. */
  fromArn?: string
  /** Override endpoint (for VPC endpoints, GovCloud, or test stubs). */
  endpoint?: string
  /** Injected fetch — defaults to global \`fetch\`. */
  fetch?: typeof fetch
  /** Injected clock — used for SigV4 signing. Exposed for tests. */
  now?: () => Date
}

const DRIVER = "ses"

const ses: DriverFactory<SesDriverOptions> = defineDriver<SesDriverOptions>((options) => {
  if (!options?.region) throw createRequiredError(DRIVER, "region")

  const credentials = resolveCredentials(options)
  if (!credentials) {
    throw createError(
      DRIVER,
      "INVALID_OPTIONS",
      "credentials not found: pass accessKeyId + secretAccessKey, or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
    )
  }

  const endpoint = options.endpoint ?? `https://email.${options.region}.amazonaws.com`
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
      tagging: true,
      replyTo: true,
      customHeaders: true,
    },

    async isAvailable() {
      return Boolean(credentials.accessKeyId && credentials.secretAccessKey)
    },

    async send(msg) {
      const payload = buildSendPayload(msg, options)
      const res = await sesRequest(
        fetchImpl,
        endpoint,
        "/v2/email/outbound-emails",
        payload,
        options,
        credentials,
      )
      if (res.error) return res as Result<EmailResult>
      const body = (res.data ?? {}) as { MessageId?: string }
      if (!body.MessageId) {
        return {
          data: null,
          error: createError(DRIVER, "PROVIDER", "ses response missing MessageId", { cause: body }),
        }
      }
      return {
        data: {
          id: body.MessageId,
          driver: DRIVER,
          at: new Date(),
          provider: body as Record<string, unknown>,
        },
        error: null,
      }
    },

    async sendBatch(msgs) {
      // SES v2 has SendBulkEmail but it requires a template; raw-MIME bulk
      // isn't a supported API. Fall back to sequential sends — the core
      // `sendBatch()` wrapper does this too, but implementing here keeps
      // the contract consistent (no `sendBatch` → fall through to sequential).
      const results: EmailResult[] = []
      for (const msg of msgs) {
        const r = await this.send!(msg, { driver: DRIVER, attempt: 1, meta: {} })
        if (r.error) return r as never
        results.push(r.data!)
      }
      return { data: results, error: null }
    },
  }
})

export default ses

function resolveCredentials(options: SesDriverOptions): AwsCredentials | null {
  const envAccess = readEnv("AWS_ACCESS_KEY_ID")
  const envSecret = readEnv("AWS_SECRET_ACCESS_KEY")
  const envSession = readEnv("AWS_SESSION_TOKEN")
  const accessKeyId = options.accessKeyId ?? envAccess
  const secretAccessKey = options.secretAccessKey ?? envSecret
  if (!accessKeyId || !secretAccessKey) return null
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: options.sessionToken ?? envSession,
  }
}

function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return g.process?.env?.[name]
}

function buildSendPayload(msg: EmailMessage, options: SesDriverOptions): Record<string, unknown> {
  const messageId =
    msg.headers?.["Message-ID"] ??
    `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@ses.amazonaws.com>`
  const mime = buildMime(normalizeMimeInput(msg, messageId))
  const destination: Record<string, string[]> = { ToAddresses: splitHeader(mime.headers.To) }
  if (mime.headers.Cc) destination.CcAddresses = splitHeader(mime.headers.Cc)
  const payload: Record<string, unknown> = {
    FromEmailAddress: mime.headers.From,
    Destination: destination,
    Content: {
      Raw: { Data: toBase64(mime.body) },
    },
  }
  if (options.configurationSetName) payload.ConfigurationSetName = options.configurationSetName
  if (options.fromArn) payload.FromEmailAddressIdentityArn = options.fromArn
  if (mime.headers["Reply-To"]) payload.ReplyToAddresses = splitHeader(mime.headers["Reply-To"])
  if (msg.tags?.length) payload.EmailTags = msg.tags.map((t) => ({ Name: t.name, Value: t.value }))
  return payload
}

function splitHeader(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const g = globalThis as {
    Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function sesRequest(
  fetchImpl: typeof fetch,
  endpoint: string,
  path: string,
  body: unknown,
  options: SesDriverOptions,
  credentials: AwsCredentials,
): Promise<Result<unknown>> {
  const bodyText = JSON.stringify(body)
  let signed
  try {
    signed = await signRequest({
      method: "POST",
      url: `${endpoint}${path}`,
      body: bodyText,
      headers: { "content-type": "application/json" },
      region: options.region,
      service: "ses",
      credentials,
      now: options.now,
    })
  } catch (err) {
    return { data: null, error: toEmailError(DRIVER, err) }
  }

  let res: Response
  try {
    res = await fetchImpl(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body,
    })
  } catch (err) {
    return { data: null, error: toEmailError(DRIVER, err) }
  }

  const text = await res.text()
  const parsed = text ? safeJson(text) : null

  if (!res.ok) {
    const apiError = (parsed ?? {}) as { message?: string; Message?: string; __type?: string }
    const errType = apiError.__type ?? ""
    const message = apiError.message ?? apiError.Message ?? `HTTP ${res.status}`
    const code =
      /InvalidClientTokenId|SignatureDoesNotMatch|AccessDenied|UnrecognizedClientException/.test(
        errType,
      )
        ? "AUTH"
        : res.status === 429 || /Throttling|TooManyRequests/.test(errType)
          ? "RATE_LIMIT"
          : res.status >= 500
            ? "NETWORK"
            : "PROVIDER"
    return {
      data: null,
      error: createError(DRIVER, code, message, {
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
