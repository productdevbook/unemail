import type { WebhookEvent, WebhookProvider } from "./index.ts"
import { timingSafeEqual, webCryptoHmacHex } from "./_crypto.ts"

/** Mailgun webhook verifier. The payload always contains
 *   \`signature: { timestamp, token, signature }\`
 *  plus an \`event-data\` block. HMAC-SHA256 of \`\${timestamp}\${token}\`
 *  keyed with the API signing key must equal \`signature\`. */
export interface MailgunWebhookOptions {
  signingKey: string
  /** Window in seconds to accept messages from. Default: 300. */
  toleranceSeconds?: number
  now?: () => number
}

interface MailgunWebhookBody {
  signature?: {
    timestamp?: string
    token?: string
    signature?: string
  }
  "event-data"?: {
    id?: string
    timestamp?: number
    event?: string
    recipient?: string
    url?: string
    severity?: string
  }
}

export default function mailgunWebhook(options: MailgunWebhookOptions): WebhookProvider {
  const tolerance = options.toleranceSeconds ?? 300
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    name: "mailgun",
    async verify(request) {
      if (request.method !== "POST") return null
      const ct = request.headers.get("content-type") ?? ""
      if (!ct.startsWith("application/json")) return null
      const body = (await request.json()) as MailgunWebhookBody
      const sig = body.signature
      if (!sig?.timestamp || !sig?.token || !sig?.signature) return []
      const ts = Number(sig.timestamp)
      if (!Number.isFinite(ts) || Math.abs(now() - ts) > tolerance) return []
      const expected = await webCryptoHmacHex(
        "SHA-256",
        options.signingKey,
        `${sig.timestamp}${sig.token}`,
      )
      if (!timingSafeEqual(expected, sig.signature)) return []
      return [normalize(body)]
    },
  }
}

function normalize(body: MailgunWebhookBody): WebhookEvent {
  const data = body["event-data"] ?? {}
  const type = mapType(data.event)
  const event: WebhookEvent = {
    type,
    id: data.id ?? "",
    at: data.timestamp ? new Date(data.timestamp * 1000) : new Date(),
    recipient: data.recipient ?? "",
    provider: "mailgun",
    raw: body,
  }
  if (type === "clicked" && data.url) event.url = data.url
  if (type === "bounced") event.bounce = data.severity === "permanent" ? "hard" : "soft"
  return event
}

function mapType(raw: string | undefined): WebhookEvent["type"] {
  switch (raw) {
    case "accepted":
      return "sent"
    case "delivered":
      return "delivered"
    case "failed":
    case "temporary_fail":
    case "permanent_fail":
      return "bounced"
    case "complained":
      return "complained"
    case "opened":
      return "opened"
    case "clicked":
      return "clicked"
    case "unsubscribed":
      return "unsubscribed"
    case "rejected":
      return "rejected"
    default:
      return "other"
  }
}
