import type { WebhookEvent, WebhookProvider } from "./index.ts"

/** AWS SES via SNS webhook verifier.
 *
 *  Full SNS signature verification requires fetching the AWS public cert
 *  advertised by \`SigningCertURL\` (we don't fetch out-of-band from the
 *  webhook in this minimal implementation). Use the \`verifySignature\`
 *  callback option to plug in \`aws-sns-signature-verification\` or your
 *  own verifier — we default to accepting on topic-ARN allow-listing. */
export interface SesWebhookOptions {
  /** Restrict to these SNS TopicArns. Recommended. */
  topicArns?: readonly string[]
  /** Optional async signature verifier (fetches \`SigningCertURL\`). */
  verifySignature?: (body: SnsEnvelope) => Promise<boolean> | boolean
}

export interface SnsEnvelope {
  Type?: string
  TopicArn?: string
  Message?: string
  Signature?: string
  SigningCertURL?: string
  SubscribeURL?: string
  MessageId?: string
  Timestamp?: string
}

interface SesMessage {
  eventType?: string
  mail?: {
    messageId?: string
    timestamp?: string
    destination?: string[]
  }
  bounce?: {
    bounceType?: string
    bouncedRecipients?: Array<{ emailAddress?: string }>
  }
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>
  }
  delivery?: { recipients?: string[] }
  open?: { timestamp?: string }
  click?: { link?: string }
}

export default function sesWebhook(options: SesWebhookOptions = {}): WebhookProvider {
  return {
    name: "ses",
    async verify(request) {
      if (request.method !== "POST") return null
      const messageType = request.headers.get("x-amz-sns-message-type")
      if (!messageType) return null
      const body = (await request.json()) as SnsEnvelope
      if (options.topicArns && body.TopicArn && !options.topicArns.includes(body.TopicArn))
        return []
      if (options.verifySignature) {
        const ok = await options.verifySignature(body)
        if (!ok) return []
      }
      if (messageType === "SubscriptionConfirmation" || messageType === "UnsubscribeConfirmation") {
        // Signal success but emit no events — callers may auto-confirm via body.SubscribeURL.
        return []
      }
      if (!body.Message) return []
      const message = JSON.parse(body.Message) as SesMessage
      return normalize(message, body)
    },
  }
}

function normalize(message: SesMessage, envelope: SnsEnvelope): WebhookEvent[] {
  const type = mapType(message.eventType)
  const base: Pick<WebhookEvent, "type" | "id" | "provider" | "raw" | "at"> = {
    type,
    id: message.mail?.messageId ?? envelope.MessageId ?? "",
    provider: "ses",
    raw: message,
    at: message.mail?.timestamp ? new Date(message.mail.timestamp) : new Date(),
  }
  const recipients = resolveRecipients(message)
  if (recipients.length === 0) return [{ ...base, recipient: "" }]
  return recipients.map((recipient) => {
    const event: WebhookEvent = { ...base, recipient }
    if (type === "bounced" && message.bounce?.bounceType)
      event.bounce = message.bounce.bounceType === "Permanent" ? "hard" : "soft"
    if (type === "clicked" && message.click?.link) event.url = message.click.link
    return event
  })
}

function resolveRecipients(message: SesMessage): string[] {
  if (message.bounce?.bouncedRecipients)
    return message.bounce.bouncedRecipients.map((r) => r.emailAddress ?? "").filter(Boolean)
  if (message.complaint?.complainedRecipients)
    return message.complaint.complainedRecipients.map((r) => r.emailAddress ?? "").filter(Boolean)
  if (message.delivery?.recipients) return message.delivery.recipients
  if (message.mail?.destination) return message.mail.destination
  return []
}

function mapType(raw: string | undefined): WebhookEvent["type"] {
  switch (raw) {
    case "Send":
      return "sent"
    case "Delivery":
      return "delivered"
    case "Bounce":
      return "bounced"
    case "Complaint":
      return "complained"
    case "Open":
      return "opened"
    case "Click":
      return "clicked"
    case "Reject":
      return "rejected"
    case "DeliveryDelay":
    case "RenderingFailure":
      return "failed"
    default:
      return "other"
  }
}
