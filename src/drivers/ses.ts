import type { DriverFactory, EmailResult, NormalizedMessage } from "../core/types.ts"
import type { AwsCredentials } from "./_ses/sigv4.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError, toEmailError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { stringToBase64 } from "./_base64.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"
import { buildMime, resolveMessageId, toMimeInput } from "./_mime.ts"
import { signRequest } from "./_ses/sigv4.ts"

export interface SesOptions {
  region: string
  /** Falls back to `AWS_ACCESS_KEY_ID`. */
  accessKeyId?: string
  /** Falls back to `AWS_SECRET_ACCESS_KEY`. */
  secretAccessKey?: string
  /** Falls back to `AWS_SESSION_TOKEN`. */
  sessionToken?: string
  /** Configuration set used for event publishing. */
  configurationSetName?: string
  /** `FromEmailAddressIdentityArn`, for cross-account sending authority. */
  fromArn?: string
  /** Override the endpoint — VPC endpoints, GovCloud, or a test stub. */
  endpoint?: string
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Injected clock, for deterministic SigV4 signatures in tests. */
  now?: () => Date
}

const DRIVER = "ses"
const AUTH_ERRORS = /InvalidClientTokenId|SignatureDoesNotMatch|AccessDenied|UnrecognizedClient/
const THROTTLE_ERRORS = /Throttling|TooManyRequests|LimitExceeded/

/**
 * Amazon SES v2 with no `@aws-sdk/*` dependency: SigV4 over Web Crypto and
 * raw MIME from the shared builder, so attachments and inline images work
 * and the whole driver runs in a Worker.
 *
 * ```ts
 * createEmail({ driver: ses({ region: "eu-central-1" }) })
 * ```
 */
const ses: DriverFactory<SesOptions> = defineDriver<SesOptions>((options) => {
  if (!options?.region) throw createRequiredError(DRIVER, "region")

  const credentials = resolveCredentials(options)
  if (!credentials) {
    throw createError(
      DRIVER,
      "INVALID_OPTIONS",
      "no credentials — pass accessKeyId + secretAccessKey, or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
    )
  }

  const endpoint = (options.endpoint ?? `https://email.${options.region}.amazonaws.com`).replace(
    /\/$/,
    "",
  )
  const fetchImpl = resolveFetch(DRIVER, options.fetch)

  return {
    name: DRIVER,
    features: {
      attachments: true,
      html: true,
      text: true,
      tagging: true,
      replyTo: true,
      customHeaders: true,
    },

    isAvailable: () => Boolean(credentials.accessKeyId && credentials.secretAccessKey),

    async send(msg, ctx) {
      const url = `${endpoint}/v2/email/outbound-emails`
      const body = JSON.stringify(toPayload(msg, options))

      let signed
      try {
        signed = await signRequest({
          method: "POST",
          url,
          body,
          headers: { "content-type": "application/json" },
          region: options.region,
          service: "ses",
          credentials,
          ...(options.now ? { now: options.now } : {}),
        })
      } catch (error) {
        return err(toEmailError(DRIVER, error))
      }

      const response = await httpJson({
        fetch: fetchImpl,
        driver: DRIVER,
        url: signed.url,
        method: signed.method,
        headers: signed.headers,
        body: signed.body,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        classify(status, parsed) {
          // SES puts the real reason in `__type`; the status alone would
          // make an expired token look like an ordinary 400.
          const type = (parsed as { __type?: string } | null)?.__type ?? ""
          if (AUTH_ERRORS.test(type)) return { code: "AUTH", retryable: false }
          if (THROTTLE_ERRORS.test(type)) return { code: "RATE_LIMIT", retryable: true }
          return { code: classifyStatus(status) }
        },
      })
      if (response.error) return err(response.error)

      const parsed = (response.data ?? {}) as { MessageId?: string }
      if (!parsed.MessageId) {
        return err(
          createError(DRIVER, "PROVIDER", "response did not contain a MessageId", {
            cause: response.data,
          }),
        )
      }
      const result: EmailResult = {
        id: parsed.MessageId,
        driver: DRIVER,
        ...(msg.stream ? { stream: msg.stream } : {}),
        at: new Date(),
        provider: parsed,
      }
      return ok(result)
    },
  }
})

export default ses

function toPayload(msg: NormalizedMessage, options: SesOptions): Record<string, unknown> {
  const mime = buildMime(toMimeInput(msg, resolveMessageId(msg, "ses.amazonaws.com")))
  const payload: Record<string, unknown> = {
    FromEmailAddress: mime.headers.From,
    // SES reads recipients off the envelope, which is where bcc lives —
    // passing the rendered headers would drop every blind recipient.
    Destination: { ToAddresses: mime.envelope.rcpt },
    Content: { Raw: { Data: stringToBase64(mime.body) } },
  }
  if (options.configurationSetName) payload.ConfigurationSetName = options.configurationSetName
  if (options.fromArn) payload.FromEmailAddressIdentityArn = options.fromArn
  if (msg.replyTo.length > 0) payload.ReplyToAddresses = msg.replyTo.map((a) => a.email)
  if (msg.tags.length > 0) {
    payload.EmailTags = msg.tags.map((tag) => ({ Name: tag.name, Value: tag.value }))
  }
  return payload
}

function resolveCredentials(options: SesOptions): AwsCredentials | null {
  const accessKeyId = options.accessKeyId ?? readEnv("AWS_ACCESS_KEY_ID")
  const secretAccessKey = options.secretAccessKey ?? readEnv("AWS_SECRET_ACCESS_KEY")
  if (!accessKeyId || !secretAccessKey) return null
  const sessionToken = options.sessionToken ?? readEnv("AWS_SESSION_TOKEN")
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}
