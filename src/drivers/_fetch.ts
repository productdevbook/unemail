import type { EmailErrorCode, Result } from "../core/types.ts"
import { createError, toEmailError } from "../core/error.ts"
import { err, ok } from "../core/result.ts"

/**
 * The one HTTP path every API-backed driver takes.
 *
 * Drivers do not parse responses, classify status codes, or wrap network
 * errors — they describe the request and read the parsed body. The status
 * taxonomy lives here so `error.retryable` means the same thing whichever
 * provider produced it.
 *
 * @module
 */

export interface HttpRequest {
  fetch: typeof fetch
  driver: string
  url: string
  method?: string
  headers?: Record<string, string>
  /** Serialized as JSON unless it is already a string. */
  body?: unknown
  /** A body to send verbatim — `FormData`, a `Blob`, a stream. Wins over
   *  `body`, and suppresses the default `content-type` so `fetch` can write
   *  its own (a multipart boundary cannot be guessed). Mailgun's Messages
   *  API is multipart, not JSON. */
  bodyInit?: BodyInit
  signal?: AbortSignal
  /** Milliseconds before the request is aborted. Default: 30_000. */
  timeoutMs?: number
  /** Refine the classification when the provider says more than the
   *  status code does — Postmark's `ErrorCode`, SES's `__type`. */
  classify?: (status: number, body: unknown) => Classification | null
  /** See the response before its body is read. For a provider that puts
   *  something a driver needs in a header: SendGrid and MailerSend both
   *  return the message id only in one, on a 202 with an empty body. Runs
   *  for failures too, so a rate-limit header is reachable either way.
   *  Must not throw. */
  onResponse?: (response: Response) => void
}

export interface Classification {
  code: EmailErrorCode
  message?: string
  retryable?: boolean
}

/** Issue a JSON request. The parsed body is the `data` on success, `null`
 *  for an empty response. */
export async function httpJson(request: HttpRequest): Promise<Result<unknown>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...request.headers,
  }
  const raw = request.bodyInit
  const hasBody = raw != null || request.body != null
  // A verbatim body carries its own encoding — for multipart that includes
  // a boundary only `fetch` knows, so anything we set here would be wrong.
  if (raw != null) delete headers["content-type"]
  else if (hasBody && !hasHeader(headers, "content-type")) {
    headers["content-type"] = "application/json"
  }

  const timeout = AbortSignal.timeout(request.timeoutMs ?? 30_000)
  const signal = request.signal ? anySignal([request.signal, timeout]) : timeout

  let response: Response
  try {
    response = await request.fetch(request.url, {
      method: request.method ?? "POST",
      headers,
      body:
        raw ??
        (request.body == null
          ? undefined
          : typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body)),
      signal,
    })
  } catch (error) {
    return err(toEmailError(request.driver, error))
  }

  request.onResponse?.(response)

  // fetch() resolves once the headers arrive, so the body is still a live
  // stream. A proxy timing out or a socket reset here used to throw past
  // the driver boundary and be reported as a non-retryable PROVIDER error —
  // exactly backwards for a transient failure.
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return err(
      createError(request.driver, "NETWORK", "connection closed while reading the response", {
        status: response.status,
        retryable: true,
        cause: error,
      }),
    )
  }
  const parsed = text ? safeJson(text) : null

  if (!response.ok) {
    const custom = request.classify?.(response.status, parsed)
    const code = custom?.code ?? classifyStatus(response.status)
    const message = custom?.message ?? extractMessage(parsed) ?? `HTTP ${response.status}`
    return err(
      createError(request.driver, code, message, {
        status: response.status,
        ...(custom?.retryable == null ? {} : { retryable: custom.retryable }),
        // Retry middleware reads `Retry-After` off these headers, so the
        // provider's own backoff advice has to survive the trip out.
        cause: { headers: response.headers, body: parsed ?? text },
      }),
    )
  }

  return ok(parsed)
}

/** Default status → code mapping. Anything 5xx or 429 is retryable; a 4xx
 *  is the caller's problem and retrying it just burns quota. */
export function classifyStatus(status: number): EmailErrorCode {
  if (status === 401 || status === 403) return "AUTH"
  if (status === 408) return "TIMEOUT"
  if (status === 429) return "RATE_LIMIT"
  if (status >= 500) return "NETWORK"
  return "PROVIDER"
}

/** Resolve the fetch a driver should use, failing at construction rather
 *  than on the first send when there is none. */
export function resolveFetch(driver: string, injected?: typeof fetch): typeof fetch {
  const impl = injected ?? globalThis.fetch
  if (typeof impl !== "function") {
    throw createError(driver, "INVALID_OPTIONS", "no global fetch — pass `fetch` explicitly")
  }
  return impl
}

/** Pull a human-readable message out of the half-dozen error envelopes
 *  the providers use between them. */
function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const record = body as Record<string, unknown>
  const direct = record.message ?? record.Message ?? record.error ?? record.detail
  if (typeof direct === "string") return direct
  const errors = record.errors
  if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
    const first = errors[0] as Record<string, unknown>
    if (typeof first.message === "string") return first.message
  }
  return null
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// `AbortSignal.any` is still missing from a few runtimes we target.
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([...signals])
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}
