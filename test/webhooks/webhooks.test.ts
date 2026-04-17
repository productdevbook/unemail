import { describe, expect, it } from "vitest"
import { defineWebhookHandler } from "../../src/webhooks/index.ts"
import mailgunWebhook from "../../src/webhooks/mailgun.ts"
import postmarkWebhook from "../../src/webhooks/postmark.ts"
import sesWebhook from "../../src/webhooks/ses.ts"
import { webCryptoHmacHex } from "../../src/webhooks/_crypto.ts"

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("mailgun webhook", () => {
  const signingKey = "mg-signing-key"
  const ts = "1000000000"
  const token = "tok-abc"

  it("accepts a correctly signed payload", async () => {
    const signature = await webCryptoHmacHex("SHA-256", signingKey, `${ts}${token}`)
    const handler = defineWebhookHandler({
      providers: [
        mailgunWebhook({ signingKey, toleranceSeconds: 10 ** 10, now: () => Number(ts) }),
      ],
      onEvent: (event) => {
        events.push(event.type)
      },
    })
    const events: string[] = []
    const res = await handler(
      jsonRequest({
        signature: { timestamp: ts, token, signature },
        "event-data": {
          id: "evt_1",
          event: "delivered",
          recipient: "a@b.com",
          timestamp: Number(ts),
        },
      }),
    )
    expect(res.status).toBe(200)
    expect(events).toEqual(["delivered"])
  })

  it("rejects a mismatched signature", async () => {
    const handler = defineWebhookHandler({
      providers: [
        mailgunWebhook({ signingKey, toleranceSeconds: 10 ** 10, now: () => Number(ts) }),
      ],
      onEvent: () => {},
    })
    const res = await handler(
      jsonRequest({
        signature: { timestamp: ts, token, signature: "deadbeef" },
        "event-data": {
          id: "evt_1",
          event: "delivered",
          recipient: "a@b.com",
          timestamp: Number(ts),
        },
      }),
    )
    expect(res.status).toBe(401)
  })

  it("rejects a stale timestamp", async () => {
    const signature = await webCryptoHmacHex("SHA-256", signingKey, `${ts}${token}`)
    const handler = defineWebhookHandler({
      providers: [
        mailgunWebhook({ signingKey, toleranceSeconds: 60, now: () => Number(ts) + 1_000_000 }),
      ],
      onEvent: () => {},
    })
    const res = await handler(
      jsonRequest({
        signature: { timestamp: ts, token, signature },
        "event-data": { id: "evt_1", event: "delivered", recipient: "a@b.com" },
      }),
    )
    expect(res.status).toBe(401)
  })
})

describe("postmark webhook", () => {
  it("normalizes delivery + bounce + click events", async () => {
    const events: Array<{ type: string; bounce?: string; url?: string }> = []
    const handler = defineWebhookHandler({
      providers: [postmarkWebhook()],
      onEvent: (e) => {
        events.push({ type: e.type, bounce: e.bounce, url: e.url })
      },
    })
    await handler(
      jsonRequest(
        {
          RecordType: "Bounce",
          MessageID: "pm_1",
          Recipient: "a@b.com",
          Type: "HardBounce",
          BouncedAt: "2026-04-17T12:00:00Z",
        },
        { "user-agent": "Postmark/webhook" },
      ),
    )
    await handler(
      jsonRequest(
        {
          RecordType: "Click",
          MessageID: "pm_2",
          Recipient: "a@b.com",
          OriginalLink: "https://x.co/y",
          ReceivedAt: "2026-04-17T12:00:00Z",
        },
        { "user-agent": "Postmark/webhook" },
      ),
    )
    expect(events).toEqual([
      { type: "bounced", bounce: "hard", url: undefined },
      { type: "clicked", bounce: undefined, url: "https://x.co/y" },
    ])
  })
})

describe("ses webhook", () => {
  it("normalizes a Bounce message nested in an SNS envelope", async () => {
    const events: Array<{ type: string; recipient: string; bounce?: string }> = []
    const handler = defineWebhookHandler({
      providers: [sesWebhook()],
      onEvent: (e) => {
        events.push({ type: e.type, recipient: e.recipient, bounce: e.bounce })
      },
    })
    const message = {
      eventType: "Bounce",
      mail: { messageId: "ses_1", timestamp: "2026-04-17T12:00:00Z", destination: ["a@b.com"] },
      bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@b.com" }] },
    }
    const res = await handler(
      jsonRequest(
        { Type: "Notification", Message: JSON.stringify(message), MessageId: "sns_1" },
        { "x-amz-sns-message-type": "Notification" },
      ),
    )
    expect(res.status).toBe(200)
    expect(events).toEqual([{ type: "bounced", recipient: "a@b.com", bounce: "hard" }])
  })

  it("respects topicArns allow-list", async () => {
    const events: unknown[] = []
    const handler = defineWebhookHandler({
      providers: [sesWebhook({ topicArns: ["arn:aws:sns:us-east-1:111111:allowed"] })],
      onEvent: (e) => {
        events.push(e)
      },
    })
    const res = await handler(
      jsonRequest(
        {
          Type: "Notification",
          TopicArn: "arn:aws:sns:us-east-1:111111:other",
          Message: JSON.stringify({}),
        },
        { "x-amz-sns-message-type": "Notification" },
      ),
    )
    expect(res.status).toBe(401)
    expect(events).toEqual([])
  })
})
