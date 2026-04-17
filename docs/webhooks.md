# Webhooks

unemail normalizes every provider's webhook payload into one shape.

```ts
type WebhookEvent = {
  type:
    | "sent"
    | "delivered"
    | "bounced"
    | "complained"
    | "opened"
    | "clicked"
    | "unsubscribed"
    | "rejected"
    | "failed"
    | "other"
  id: string
  at: Date
  recipient: string
  provider: string
  raw: unknown // original payload preserved
  url?: string // for "clicked"
  bounce?: "hard" | "soft" | "unknown"
}
```

## Wiring it up

```ts
import { defineWebhookHandler } from "unemail/webhooks"
import resendWebhook from "unemail/webhooks/resend"
import postmarkWebhook from "unemail/webhooks/postmark"
import mailgunWebhook from "unemail/webhooks/mailgun"
import sendgridWebhook from "unemail/webhooks/sendgrid"
import sesWebhook from "unemail/webhooks/ses"

export default defineWebhookHandler({
  providers: [
    resendWebhook({ secret: process.env.RESEND_WEBHOOK_SECRET! }),
    postmarkWebhook({ basicAuth: "user:pass" }),
    mailgunWebhook({ signingKey: process.env.MG_SIGNING_KEY! }),
    sendgridWebhook({ publicKey: process.env.SG_PUBLIC_KEY! }),
    sesWebhook({ topicArns: [process.env.SES_TOPIC_ARN!] }),
  ],
  async onEvent(event) {
    console.log(event.type, event.recipient, event.id)
    if (event.type === "bounced" && event.bounce === "hard") {
      await suppressionList.add(event.recipient)
    }
  },
})
```

Every verifier runs on Web Crypto — no `node:crypto`, no vendor SDK,
Cloudflare Workers ready.

## Signature formats

| Provider  | Header(s)                                            | Scheme                                             |
| --------- | ---------------------------------------------------- | -------------------------------------------------- |
| Resend    | `svix-id`, `svix-timestamp`, `svix-signature`        | HMAC-SHA256 (base64 secret)                        |
| Postmark  | `authorization: Basic ...`                           | HTTP Basic                                         |
| Mailgun   | payload `signature.{timestamp,token,signature}`      | HMAC-SHA256 of `ts+token`                          |
| SendGrid  | `x-twilio-email-event-webhook-{timestamp,signature}` | ECDSA P-256 / SHA-256                              |
| SES (SNS) | `x-amz-sns-message-type`                             | TopicArn allow-list + optional cert-fetch callback |

## Timestamp windows

Each verifier accepts a `toleranceSeconds` option (default `300`) to
reject replayed payloads. Missing timestamps fail closed.

## Failure behavior

Returning `[]` from a verifier means "this looks like my payload but the
signature is bad" — the handler responds `401`. Returning `null` means
"not my payload" — the handler tries the next provider.
