import type { Result } from "../types.ts"
import { createError, toEmailError } from "../errors.ts"

/** Thin wrapper around `fetch` used by every HTTP-based driver (Resend,
 *  Postmark, SendGrid, Mailgun, Brevo, MailerSend, Loops, Zeptomail,
 *  MailChannels, HTTP). Handles JSON encoding, response parsing, and
 *  mapping HTTP status codes to our `EmailErrorCode` taxonomy.
 *
 *  Drivers pass a tiny `classifyError()` callback when the provider
 *  returns richer error codes than plain HTTP (Postmark's `ErrorCode 10`,
 *  SendGrid's `errors[].field`, etc.).
 */
export interface HttpRequestInit {
  fetch: typeof fetch
  driver: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  /** Return a custom EmailErrorCode classification from the parsed body. */
  classifyError?: (
    status: number,
    body: unknown,
  ) => {
    code: "AUTH" | "RATE_LIMIT" | "NETWORK" | "PROVIDER"
    retryable?: boolean
    message?: string
  } | null
}

/** Issue a JSON HTTP request and return a `Result<unknown>` where the
 *  data is the parsed response (or null for empty bodies). */
export async function httpJson(init: HttpRequestInit): Promise<Result<unknown>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    ...init.headers,
  }

  let res: Response
  try {
    res = await init.fetch(init.url, {
      method: init.method ?? "POST",
      headers,
      body: init.body == null ? undefined : JSON.stringify(init.body),
    })
  } catch (err) {
    return { data: null, error: toEmailError(init.driver, err) }
  }

  const text = await res.text()
  const parsed = text ? safeJson(text) : null

  if (!res.ok) {
    const custom = init.classifyError?.(res.status, parsed)
    const code = custom?.code ?? defaultCodeForStatus(res.status)
    const message = custom?.message ?? extractMessage(parsed) ?? `HTTP ${res.status}`
    const retryable = custom?.retryable ?? (code === "RATE_LIMIT" || code === "NETWORK")
    return {
      data: null,
      error: createError(init.driver, code, message, {
        status: res.status,
        retryable,
        cause: { headers: res.headers, body: parsed ?? text },
      }),
    }
  }

  return { data: parsed, error: null }
}

function defaultCodeForStatus(status: number): "AUTH" | "RATE_LIMIT" | "NETWORK" | "PROVIDER" {
  if (status === 401 || status === 403) return "AUTH"
  if (status === 429) return "RATE_LIMIT"
  if (status >= 500) return "NETWORK"
  return "PROVIDER"
}

function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const record = body as Record<string, unknown>
  // Common shapes: { message }, { Message }, { error }, { errors: [{ message }] }
  const direct = record.message ?? record.Message ?? record.error ?? record.detail
  if (typeof direct === "string") return direct
  if (Array.isArray(record.errors) && record.errors[0] && typeof record.errors[0] === "object") {
    const first = record.errors[0] as Record<string, unknown>
    if (typeof first.message === "string") return first.message
  }
  return null
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
