import type {
  Attachment,
  DriverFactory,
  EmailAddress,
  EmailResult,
  NormalizedMessage,
  Result,
  SendState,
  SendStatus,
} from "../core/types.ts"
import type { AzureCredentials } from "./_azure/sign.ts"
import { defineDriver } from "../core/define.ts"
import { createError, createRequiredError, toEmailError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"
import { isAccessKey, parseConnectionString, signRequest } from "./_azure/sign.ts"
import { attachmentToBase64 } from "./_base64.ts"
import { toUuid } from "./_uuid.ts"
import { classifyStatus, httpJson, resolveFetch } from "./_fetch.ts"

export interface AzureCommunicationOptions {
  /** `endpoint=https://…;accesskey=…`, exactly as the resource's Keys blade
   *  prints it. Use this, or `endpoint` + `accessKey`. Falls back to
   *  `COMMUNICATION_SERVICES_CONNECTION_STRING`. */
  connectionString?: string
  /** Resource endpoint, e.g. `https://my-resource.communication.azure.com`. */
  endpoint?: string
  /** Base64 access key from the resource's Keys blade. */
  accessKey?: string
  /** REST API version. Default: `2025-09-01`. */
  apiVersion?: string
  /** Turn Azure's open/click tracking off for every send. A message's own
   *  `tracking` wins over this. */
  userEngagementTrackingDisabled?: boolean
  /** Abort a request after this long, in milliseconds. Default: 30_000.
   *  Lower it behind a user-facing handler so the retry middleware gets
   *  control before the caller's own request times out. */
  timeoutMs?: number
  /** Injected fetch. Defaults to the global. */
  fetch?: typeof fetch
  /** Injected clock, for deterministic signatures in tests. */
  now?: () => Date
}

interface AzureSendResult {
  id?: string
  status?: string
  error?: { code?: string; message?: string }
}

const DRIVER = "azure-communication"
const API_VERSION = "2025-09-01"
const ENV_CONNECTION_STRING = "COMMUNICATION_SERVICES_CONNECTION_STRING"
/** Azure caps the whole send request — body, attachments and inline images
 *  together — at 10 MB. */
const MAX_REQUEST_BYTES = 10 * 1024 * 1024
/** Azure's own error codes that mean "this key cannot do this", whatever
 *  status they arrive with. */
const AUTH_CODES = /Unauthorized|Unauthenticated|Forbidden|DenyAction|AuthenticationFailed/i
const THROTTLE_CODES = /TooManyRequests|Throttl|QuotaExceeded/i

/**
 * Azure Communication Services Email, over its REST API — HMAC-SHA256 over
 * Web Crypto instead of a bearer token, and no `@azure/*` package, so the
 * whole driver runs in a Worker.
 *
 * A send is a long-running operation: the POST answers `202` with an
 * operation id, and delivery is reported separately. So `send()` returns
 * that id and `retrieve(id)` polls the operation — which is why this driver
 * declares `retrievable` without needing a paid analytics add-on.
 *
 * ```ts
 * createEmail({
 *   driver: azureCommunication({ connectionString: process.env.ACS_CONNECTION_STRING! }),
 * })
 * ```
 */
const azureCommunication: DriverFactory<AzureCommunicationOptions> =
  defineDriver<AzureCommunicationOptions>((options) => {
    const credentials = resolveCredentials(options)
    const apiVersion = options.apiVersion ?? API_VERSION
    const fetchImpl = resolveFetch(DRIVER, options.fetch)

    async function call(init: {
      method: string
      url: string
      body?: string
      headers?: Record<string, string>
      signal?: AbortSignal
      onResponse?: (response: Response) => void
    }): Promise<Result<unknown>> {
      let signed
      try {
        signed = await signRequest({
          method: init.method,
          url: init.url,
          accessKey: credentials.accessKey,
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(init.headers ? { headers: init.headers } : {}),
          ...(options.now ? { now: options.now } : {}),
        })
      } catch (error) {
        return err(toEmailError(DRIVER, error))
      }

      return httpJson({
        fetch: fetchImpl,
        driver: DRIVER,
        url: signed.url,
        method: signed.method,
        headers: signed.headers,
        ...(signed.body === undefined ? {} : { body: signed.body }),
        ...(init.signal ? { signal: init.signal } : {}),
        ...(init.onResponse ? { onResponse: init.onResponse } : {}),
        ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
        classify(status, parsed) {
          // Azure nests the reason under `error`, which the shared
          // extractor cannot read, so every failure would otherwise be
          // reported as a bare "HTTP 400".
          const detail = (parsed as { error?: { code?: string; message?: string } } | null)?.error
          const message = detail?.message
          const suffix = message ? { message } : {}
          const code = detail?.code ?? ""
          if (AUTH_CODES.test(code)) return { code: "AUTH", ...suffix }
          if (THROTTLE_CODES.test(code)) return { code: "RATE_LIMIT", ...suffix }
          return { code: classifyStatus(status), ...suffix }
        },
      })
    }

    return {
      name: DRIVER,
      features: {
        attachments: true,
        html: true,
        text: true,
        idempotency: true,
        tracking: true,
        templates: false,
        tagging: true,
        replyTo: true,
        customHeaders: true,
        retrievable: true,
      },

      isAvailable: () => Boolean(credentials.endpoint && credentials.accessKey),

      async send(msg, ctx) {
        let body: string
        try {
          body = JSON.stringify(toPayload(msg, options))
        } catch (error) {
          // `attachmentToBase64` throws for a `url` attachment, which the
          // core should already have refused.
          return err(toEmailError(DRIVER, error))
        }

        const bytes = new TextEncoder().encode(body).length
        if (bytes > MAX_REQUEST_BYTES) {
          return err(
            createError(
              DRIVER,
              "INVALID_OPTIONS",
              `request is ${bytes} bytes; Azure accepts at most ${MAX_REQUEST_BYTES} including attachments`,
            ),
          )
        }

        const operationId = await toOperationId(msg.idempotencyKey)
        let location: string | undefined
        let retryAfter: string | undefined

        const response = await call({
          method: "POST",
          url: `${credentials.endpoint}/emails:send?api-version=${apiVersion}`,
          body,
          headers: operationId ? { "operation-id": operationId } : {},
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onResponse(raw) {
            // The 202 body carries the id too, but the operation URL exists
            // only here — and on a provider that ever omits the body, it is
            // the only place the id survives.
            location = raw.headers.get("operation-location") ?? undefined
            retryAfter = raw.headers.get("retry-after") ?? undefined
          },
        })
        if (response.error) return err(response.error)

        const parsed = (response.data ?? {}) as AzureSendResult
        const id = parsed.id ?? operationIdFrom(location) ?? operationId
        if (!id) {
          return err(
            createError(DRIVER, "PROVIDER", "response carried no operation id", {
              cause: response.data,
            }),
          )
        }

        const result: EmailResult = {
          id,
          driver: DRIVER,
          ...(msg.stream ? { stream: msg.stream } : {}),
          at: new Date(),
          provider: {
            ...parsed,
            ...(location ? { operationLocation: location } : {}),
            ...(retryAfter ? { retryAfter } : {}),
          },
        }
        return ok(result)
      },

      async retrieve(id, ctx) {
        const response = await call({
          method: "GET",
          url: `${credentials.endpoint}/emails/operations/${encodeURIComponent(id)}?api-version=${apiVersion}`,
          // A send here is a long-running operation, so `retrieve` is a
          // poll — the one place in this driver where a caller giving up
          // has to be able to stop the request.
          ...(ctx?.signal ? { signal: ctx.signal } : {}),
        })
        if (response.error) return err(response.error)

        const parsed = (response.data ?? {}) as AzureSendResult
        const status: SendStatus = {
          id: parsed.id ?? id,
          driver: DRIVER,
          state: toState(parsed.status),
          provider: parsed as Record<string, unknown>,
        }
        return ok(status)
      },
    }
  })

export default azureCommunication

function resolveCredentials(options: AzureCommunicationOptions): AzureCredentials {
  if (options?.connectionString) return fromConnectionString(options.connectionString)

  if (options?.endpoint && options.accessKey) {
    if (!isAccessKey(options.accessKey)) {
      throw createError(
        DRIVER,
        "INVALID_OPTIONS",
        "`accessKey` must be the base64 key from the resource's Keys blade",
      )
    }
    return { endpoint: options.endpoint.replace(/\/+$/, ""), accessKey: options.accessKey }
  }

  const fromEnv = readEnv(ENV_CONNECTION_STRING)
  if (fromEnv) return fromConnectionString(fromEnv)

  throw createRequiredError(DRIVER, ["connectionString", "or endpoint + accessKey"])
}

function fromConnectionString(value: string): AzureCredentials {
  const parsed = parseConnectionString(value)
  if (!parsed) {
    throw createError(
      DRIVER,
      "INVALID_OPTIONS",
      "malformed connection string — expected `endpoint=https://…;accesskey=…`",
    )
  }
  return parsed
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

function toPayload(
  msg: NormalizedMessage,
  options: AzureCommunicationOptions,
): Record<string, unknown> {
  const content: Record<string, string> = { subject: msg.subject ?? "" }
  if (msg.text != null) content.plainText = msg.text
  if (msg.html != null) content.html = msg.html

  const recipients: Record<string, unknown> = { to: msg.to.map(toAddress) }
  if (msg.cc.length > 0) recipients.cc = msg.cc.map(toAddress)
  if (msg.bcc.length > 0) recipients.bcc = msg.bcc.map(toAddress)

  // Azure has no metadata or tag field of its own; `headers` is the only
  // per-message bag a send can carry, so both land there rather than being
  // dropped on the floor.
  const headers: Record<string, string> = { ...msg.headers }
  for (const [key, value] of Object.entries(msg.metadata)) headers[`X-Metadata-${key}`] = value
  for (const tag of msg.tags) headers[`X-Tag-${tag.name}`] = tag.value

  const payload: Record<string, unknown> = {
    // Azure takes a bare address; the display name is configured on the
    // sender in the portal, so `from.name` has nowhere to go.
    senderAddress: msg.from.email,
    recipients,
    content,
  }
  if (msg.replyTo.length > 0) payload.replyTo = msg.replyTo.map(toAddress)
  if (Object.keys(headers).length > 0) payload.headers = headers
  if (msg.attachments.length > 0) payload.attachments = msg.attachments.map(toAzureAttachment)

  const disabled = trackingDisabled(msg, options)
  if (disabled != null) payload.userEngagementTrackingDisabled = disabled
  return payload
}

function toAddress(address: EmailAddress): Record<string, string> {
  return address.name
    ? { address: address.email, displayName: address.name }
    : { address: address.email }
}

function toAzureAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    name: attachment.filename,
    contentType: attachment.contentType ?? "application/octet-stream",
    contentInBase64: attachmentToBase64(attachment),
    ...(attachment.cid ? { contentId: attachment.cid } : {}),
  }
}

/** Azure has one switch covering opens and clicks together, and it can only
 *  turn the resource-level setting off — never on. So tracking is disabled
 *  unless the message asks for one of the two. */
function trackingDisabled(
  msg: NormalizedMessage,
  options: AzureCommunicationOptions,
): boolean | undefined {
  if (msg.tracking) return !(msg.tracking.opens === true || msg.tracking.clicks === true)
  return options.userEngagementTrackingDisabled
}

/** Azure requires `Operation-Id` to be a UUID; `toUuid` is the shared rule. */
async function toOperationId(key?: string): Promise<string | undefined> {
  return key ? toUuid(key) : undefined
}

/** `…/emails/operations/{id}?api-version=…` */
function operationIdFrom(location?: string): string | undefined {
  if (!location) return undefined
  const match = /\/emails\/operations\/([^/?#]+)/.exec(location)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

/** Azure reports the send operation, not the delivery: `Succeeded` means the
 *  message was accepted for delivery, which is `sent` rather than
 *  `delivered`. Delivery itself arrives over Event Grid. */
function toState(status?: string): SendState {
  switch (status) {
    case "NotStarted":
    case "Running":
      return "queued"
    case "Succeeded":
      return "sent"
    case "Failed":
      return "failed"
    case "Canceled":
      return "cancelled"
    default:
      return "unknown"
  }
}
