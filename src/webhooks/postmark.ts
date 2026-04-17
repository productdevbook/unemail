import type { WebhookEvent, WebhookProvider } from "./index.ts"
import { timingSafeEqual } from "./_crypto.ts"

/** Postmark webhook verifier. Postmark doesn't expose an HMAC — the
 *  standard integration uses HTTP Basic auth on the webhook URL. Pass
 *  \`basicAuth\` to enable verification. */
export interface PostmarkWebhookOptions {
  basicAuth?: string
}

interface PostmarkWebhookBody {
  RecordType?: string
  MessageID?: string
  Recipient?: string
  Email?: string
  DeliveredAt?: string
  ReceivedAt?: string
  BouncedAt?: string
  Type?: string
  OriginalLink?: string
}

export default function postmarkWebhook(options: PostmarkWebhookOptions = {}): WebhookProvider {
  return {
    name: "postmark",
    async verify(request) {
      if (request.method !== "POST") return null
      if (!(request.headers.get("user-agent") ?? "").toLowerCase().includes("postmark")) return null
      if (options.basicAuth) {
        const auth = request.headers.get("authorization") ?? ""
        if (!auth.startsWith("Basic ")) return []
        let decoded = ""
        try {
          decoded = atob(auth.slice(6))
        } catch {
          return []
        }
        if (!timingSafeEqual(decoded, options.basicAuth)) return []
      }
      const body = (await request.json()) as PostmarkWebhookBody
      return [normalize(body)]
    },
  }
}

function normalize(body: PostmarkWebhookBody): WebhookEvent {
  const type = mapType(body.RecordType)
  const at = body.DeliveredAt ?? body.BouncedAt ?? body.ReceivedAt
  const event: WebhookEvent = {
    type,
    id: body.MessageID ?? "",
    at: at ? new Date(at) : new Date(),
    recipient: body.Recipient ?? body.Email ?? "",
    provider: "postmark",
    raw: body,
  }
  if (type === "clicked" && body.OriginalLink) event.url = body.OriginalLink
  if (type === "bounced" && body.Type)
    event.bounce = /HardBounce|BadEmailAddress|ManuallyDeactivated/i.test(body.Type)
      ? "hard"
      : "soft"
  return event
}

function mapType(raw: string | undefined): WebhookEvent["type"] {
  switch (raw) {
    case "Delivery":
      return "delivered"
    case "Bounce":
      return "bounced"
    case "SpamComplaint":
      return "complained"
    case "Open":
      return "opened"
    case "Click":
      return "clicked"
    case "SubscriptionChange":
      return "unsubscribed"
    default:
      return "other"
  }
}
