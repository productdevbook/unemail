/**
 * Prometheus-style counters + histograms for `email.send`. Exposes a
 * `.expose()` helper that produces plaintext in the Prometheus
 * exposition format — hand this to a `/metrics` endpoint in any
 * framework.
 *
 * OTLP export is covered by the existing `withTelemetry` middleware.
 *
 * @module
 */

import type { Middleware } from "../types.ts"

export interface MetricsRegistry {
  readonly sends: number
  readonly errors: Record<string, number>
  readonly durationsMs: number[]
  incSend: (driver: string) => void
  incError: (driver: string, code: string) => void
  observeDuration: (driver: string, ms: number) => void
  expose: () => string
}

export function createMetricsRegistry(): MetricsRegistry {
  let sends = 0
  const byDriver = new Map<string, number>()
  const errors = new Map<string, number>()
  const durations: number[] = []
  const driverDurations = new Map<string, number[]>()
  return {
    get sends() {
      return sends
    },
    get errors() {
      return Object.fromEntries(errors)
    },
    get durationsMs() {
      return [...durations]
    },
    incSend(driver) {
      sends++
      byDriver.set(driver, (byDriver.get(driver) ?? 0) + 1)
    },
    incError(driver, code) {
      const key = `${driver}|${code}`
      errors.set(key, (errors.get(key) ?? 0) + 1)
    },
    observeDuration(driver, ms) {
      durations.push(ms)
      const arr = driverDurations.get(driver) ?? []
      arr.push(ms)
      driverDurations.set(driver, arr)
    },
    expose() {
      const lines: string[] = []
      lines.push("# HELP unemail_sends_total Total sends by driver")
      lines.push("# TYPE unemail_sends_total counter")
      for (const [driver, n] of byDriver) lines.push(`unemail_sends_total{driver="${driver}"} ${n}`)
      lines.push("# HELP unemail_errors_total Total errors by driver and code")
      lines.push("# TYPE unemail_errors_total counter")
      for (const [key, n] of errors) {
        const [driver, code] = key.split("|")
        lines.push(`unemail_errors_total{driver="${driver}",code="${code}"} ${n}`)
      }
      lines.push("# HELP unemail_send_duration_ms Send durations in milliseconds")
      lines.push("# TYPE unemail_send_duration_ms summary")
      for (const [driver, arr] of driverDurations) {
        arr.sort((a, b) => a - b)
        const pct = (p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0
        lines.push(
          `unemail_send_duration_ms{driver="${driver}",quantile="0.5"} ${pct(0.5)}`,
          `unemail_send_duration_ms{driver="${driver}",quantile="0.9"} ${pct(0.9)}`,
          `unemail_send_duration_ms{driver="${driver}",quantile="0.99"} ${pct(0.99)}`,
          `unemail_send_duration_ms_sum{driver="${driver}"} ${arr.reduce((a, b) => a + b, 0)}`,
          `unemail_send_duration_ms_count{driver="${driver}"} ${arr.length}`,
        )
      }
      return lines.join("\n") + "\n"
    },
  }
}

export interface MetricsMiddlewareOptions {
  registry: MetricsRegistry
  now?: () => number
}

/** Middleware that records counters + durations into a registry. */
export function withMetrics(options: MetricsMiddlewareOptions): Middleware {
  const now = options.now ?? Date.now
  const started = new WeakMap<object, number>()
  return {
    name: "metrics",
    beforeSend(msg) {
      started.set(msg as object, now())
    },
    afterSend(msg, ctx, result) {
      const t0 = started.get(msg as object) ?? now()
      options.registry.observeDuration(ctx.driver, now() - t0)
      if (result.error) options.registry.incError(ctx.driver, result.error.code)
      else options.registry.incSend(ctx.driver)
    },
  }
}
