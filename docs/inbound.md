# Inbound email

unemail ships two complementary pieces:

- `unemail/parse` — parse raw MIME into a unified `ParsedEmail`
- `unemail/inbound` — handle provider webhook routes and give you the
  same `ParsedEmail` regardless of which provider delivered the message

## Low-level parsing

```ts
import { parseEmail } from "unemail/parse"

const mail = await parseEmail(rawMime)
// { subject, from, to, cc, bcc, text, html, headers, attachments, ... }
```

`parseEmail` accepts `string`, `Uint8Array`, `ArrayBuffer`, `Blob`, or
`ReadableStream`. It wraps [postal-mime](https://github.com/postalsys/postal-mime)
as an optional peer dep — the entry is Workers-parseable even without it
installed (loaded on first call).

## Unified inbound handler

```ts
import { defineInboundHandler } from "unemail/inbound"
import sendgridInbound from "unemail/inbound/sendgrid"
import mailgunInbound from "unemail/inbound/mailgun"
import postmarkInbound from "unemail/inbound/postmark"
import cloudflareInbound from "unemail/inbound/cloudflare"

export default defineInboundHandler({
  providers: [
    sendgridInbound(),
    mailgunInbound({ signingKey: process.env.MG_SIGNING_KEY! }),
    postmarkInbound({ basicAuth: "user:pass" }),
    cloudflareInbound({ secretHeader: "x-secret", secret: process.env.INBOUND_SECRET }),
  ],
  async onEmail(mail, ctx) {
    console.log(`[${ctx.provider}]`, mail.subject, "from", mail.from?.email)
    // mail: ParsedEmail — same shape regardless of provider
  },
})
```

The returned handler is a standard `(req: Request) => Promise<Response>`
— drop it into Nitro, a Cloudflare Worker, Hono, Next.js route handlers,
or a raw `fetch` listener.

### Signature verification

Each adapter accepts provider-specific verification options (shared
secrets, HMAC keys, Basic auth). Failures return `401` by default; pass
`onVerificationFailure` to customize.

### SES inbound

AWS SES routes inbound mail through SNS, so it's handled by the SES
webhook verifier — see [webhooks](./webhooks.md). The SNS payload
includes the raw MIME when you set up the receipt rule to store the
message in S3 or pass it through SNS directly.
