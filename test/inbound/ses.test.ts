import { describe, expect, it } from "vitest"
import { defineSesInboundHandler } from "../../src/inbound/ses.ts"

describe("SES inbound adapter", () => {
  it("handles SubscriptionConfirmation with optional auto-confirm", async () => {
    let confirmed = ""
    const handler = await defineSesInboundHandler({
      autoConfirm: (url) => {
        confirmed = url
      },
    })
    const event = await handler(
      JSON.stringify({
        Type: "SubscriptionConfirmation",
        SubscribeURL: "https://sns/confirm?x=1",
      }),
    )
    expect(event.type).toBe("subscription-confirm")
    expect(confirmed).toBe("https://sns/confirm?x=1")
  })

  it("normalizes Bounce notifications", async () => {
    const handler = await defineSesInboundHandler()
    const event = await handler(
      JSON.stringify({
        Type: "Notification",
        Message: JSON.stringify({
          notificationType: "Bounce",
          bounce: { bounceType: "Permanent" },
        }),
      }),
    )
    expect(event.type).toBe("bounce")
    if (event.type === "bounce") expect(event.bounce.bounceType).toBe("Permanent")
  })
})
