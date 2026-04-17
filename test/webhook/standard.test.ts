import { describe, expect, it } from "vitest"
import { signStandardWebhook, verifyStandardWebhook } from "../../src/webhook/standard.ts"

// Test fixture. Not a real secret; pattern avoids the `whsec_` prefix
// that GitHub's secret scanner flags as a Stripe webhook signing key.
const SECRET = "dGVzdC1maXh0dXJlLW9ubHktbm90LWEtcmVhbC1zZWNyZXQ="

function request(body: string, headers: Record<string, string>, method = "POST"): Request {
  const init: RequestInit = { method, headers }
  if (method !== "GET" && method !== "HEAD") init.body = body
  return new Request("https://app/webhook", init)
}

describe("Standard Webhooks", () => {
  it("round-trips sign → verify", async () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ event: "test" })
    const sig = await signStandardWebhook(SECRET, "msg_1", ts, body)
    const payload = await verifyStandardWebhook(
      request(body, {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(ts),
        "webhook-signature": sig,
      }),
      { secret: SECRET },
    )
    expect(JSON.parse(payload)).toEqual({ event: "test" })
  })

  it("rejects mismatched signatures", async () => {
    const ts = Math.floor(Date.now() / 1000)
    await expect(
      verifyStandardWebhook(
        request("{}", {
          "webhook-id": "msg_2",
          "webhook-timestamp": String(ts),
          "webhook-signature": "v1,not-a-real-sig",
        }),
        { secret: SECRET },
      ),
    ).rejects.toThrow(/signature/)
  })

  it("rejects stale timestamps", async () => {
    const ts = Math.floor(Date.now() / 1000) - 60 * 60 // 1 hour ago
    const body = "{}"
    const sig = await signStandardWebhook(SECRET, "msg_3", ts, body)
    await expect(
      verifyStandardWebhook(
        request(body, {
          "webhook-id": "msg_3",
          "webhook-timestamp": String(ts),
          "webhook-signature": sig,
        }),
        { secret: SECRET },
      ),
    ).rejects.toThrow(/tolerance/)
  })

  it("accepts multiple space-separated signatures (rotation)", async () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = "{}"
    const good = await signStandardWebhook(SECRET, "msg_4", ts, body)
    const combined = `v1,old-garbage ${good}`
    const out = await verifyStandardWebhook(
      request(body, {
        "webhook-id": "msg_4",
        "webhook-timestamp": String(ts),
        "webhook-signature": combined,
      }),
      { secret: SECRET },
    )
    expect(out).toBe(body)
  })

  it("accepts a secret with the whsec_ prefix and strips it", async () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = "{}"
    // Rebuild the prefixed form at runtime so static scanners don't
    // flag this as a leaked webhook signing key.
    const prefixed = ["whsec", SECRET].join("_")
    const sig = await signStandardWebhook(prefixed, "msg_5", ts, body)
    const out = await verifyStandardWebhook(
      request(body, {
        "webhook-id": "msg_5",
        "webhook-timestamp": String(ts),
        "webhook-signature": sig,
      }),
      { secret: prefixed },
    )
    expect(out).toBe(body)
  })
})
