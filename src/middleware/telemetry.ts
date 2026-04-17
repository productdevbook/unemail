import type { Middleware } from "../types.ts"
import { normalizeAddresses } from "../_normalize.ts"

/** Minimal OpenTelemetry \`Tracer\` surface we need — matches
 *  \`@opentelemetry/api\` but typed locally so the middleware doesn't
 *  require the peer at build time. */
export interface OtelTracer {
  startActiveSpan: <T>(
    name: string,
    options: { attributes?: Record<string, unknown> },
    fn: (span: OtelSpan) => T | Promise<T>,
  ) => T | Promise<T>
}

export interface OtelSpan {
  setAttribute: (key: string, value: unknown) => void
  recordException: (err: unknown) => void
  setStatus: (status: { code: 1 | 2; message?: string }) => void
  end: () => void
}

export interface TelemetryOptions {
  /** Tracer to drive. Usually \`trace.getTracer("unemail")\` from
   *  \`@opentelemetry/api\`. When omitted the middleware is a no-op. */
  tracer?: OtelTracer
  /** Sampling hook — return \`false\` to skip span creation for a given
   *  send (useful to avoid tracing health-check emails). */
  sample?: (attributes: Record<string, unknown>) => boolean
}

/** Middleware that wraps each send in an OpenTelemetry span.
 *
 *  ```ts
 *  import { trace } from "@opentelemetry/api"
 *  email.use(withTelemetry({ tracer: trace.getTracer("unemail") }))
 *  ```
 *
 *  Attributes emitted:
 *   - \`email.driver\`, \`email.stream\`, \`email.attempt\`
 *   - \`email.to\`, \`email.subject.length\`
 *   - \`email.message_id\` (set on success)
 *   - \`email.error.code\` (set on failure)
 *
 *  The full recipient is emitted — strip it by wrapping \`tracer\` yourself
 *  if you have stricter PII rules. */
export function withTelemetry(options: TelemetryOptions = {}): Middleware {
  const tracer = options.tracer
  if (!tracer) {
    // No-op middleware when OTel isn't wired up.
    return { name: "telemetry" }
  }
  return {
    name: "telemetry",
    async beforeSend(msg, ctx) {
      const attrs: Record<string, unknown> = {
        "email.driver": ctx.driver,
        "email.attempt": ctx.attempt,
        "email.subject.length": msg.subject.length,
      }
      if (ctx.stream) attrs["email.stream"] = ctx.stream
      const recipient = normalizeAddresses(msg.to)[0]?.email
      if (recipient) attrs["email.to"] = recipient
      if (options.sample && !options.sample(attrs)) return

      // We can't wrap the whole send around startActiveSpan from a hook,
      // so we open a span here and close it in afterSend/onError via meta.
      let resolveSpan!: (value: OtelSpan) => void
      const spanPromise = new Promise<OtelSpan>((resolve) => {
        resolveSpan = resolve
      })
      // We don't await this — fire-and-forget so the span's lifetime
      // spans the whole send.
      void tracer.startActiveSpan("email.send", { attributes: attrs }, async (span) => {
        resolveSpan(span)
        // Keep the active context open until afterSend/onError closes it.
        await new Promise<void>((r) => {
          ctx.meta.__telemetryEnd = r
        })
      })
      ctx.meta.__telemetrySpan = await spanPromise
    },
    afterSend(_msg, ctx, result) {
      const span = ctx.meta.__telemetrySpan as OtelSpan | undefined
      if (!span) return
      if (result.data) {
        span.setAttribute("email.message_id", result.data.id)
        span.setStatus({ code: 1 }) // OK
      } else if (result.error) {
        span.setAttribute("email.error.code", result.error.code)
        span.recordException(result.error)
        span.setStatus({ code: 2, message: result.error.message })
      }
      span.end()
      ;(ctx.meta.__telemetryEnd as (() => void) | undefined)?.()
    },
    onError(_msg, ctx, error) {
      const span = ctx.meta.__telemetrySpan as OtelSpan | undefined
      if (!span) return
      span.setAttribute("email.error.code", error.code)
      span.recordException(error)
      span.setStatus({ code: 2, message: error.message })
      span.end()
      ;(ctx.meta.__telemetryEnd as (() => void) | undefined)?.()
    },
  }
}
