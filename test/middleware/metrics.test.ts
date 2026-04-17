import { describe, expect, it } from "vitest"
import { createEmail } from "../../src/index.ts"
import { createMetricsRegistry, withMetrics } from "../../src/middleware/metrics.ts"
import mock from "../../src/driver/mock.ts"

describe("withMetrics", () => {
  it("records counters and exposes Prometheus text format", async () => {
    const registry = createMetricsRegistry()
    const email = createEmail({ driver: mock() })
    email.use(withMetrics({ registry }))
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    expect(registry.sends).toBe(2)
    const text = registry.expose()
    expect(text).toContain('unemail_sends_total{driver="mock"} 2')
    expect(text).toContain("unemail_send_duration_ms")
  })

  it("records errors by code", async () => {
    const registry = createMetricsRegistry()
    const email = createEmail({ driver: mock({ fail: true }) })
    email.use(withMetrics({ registry }))
    await email.send({ from: "a@b.com", to: "c@d.com", subject: "hi", text: "x" })
    const text = registry.expose()
    expect(text).toContain("unemail_errors_total")
  })
})
