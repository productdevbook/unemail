# Drivers

Every transport in unemail is a driver — a small module conforming to
`EmailDriver`. You wire one into `createEmail({ driver })` and never
touch it again; swapping providers is a one-line change.

## Built-in drivers

| Sub-path                                  | Runtime            | Attachments |  Batch  | Scheduling | Idempotency | Templates | Tags | Streams |
| ----------------------------------------- | ------------------ | :---------: | :-----: | :--------: | :---------: | :-------: | :--: | :-----: |
| `unemail/driver/mock`                     | all                |      ✓      |    ✓    |     ✓      |      ✓      |     –     |  ✓   |    –    |
| `unemail/driver/smtp`                     | Node + Bun         |      ✓      | ✓ (seq) |     –      |      –      |     –     |  –   |    –    |
| `unemail/driver/mailcrab`                 | Node (local only)  |      ✓      |    ✓    |     –      |      –      |     –     |  –   |    –    |
| `unemail/driver/resend`                   | all                |      ✓      |    ✓    |     ✓      |      ✓      |     ✓     |  ✓   |    –    |
| `unemail/driver/postmark`                 | all                |      ✓      |    ✓    |     –      |      –      |     ✓     |  ✓   |    ✓    |
| `unemail/driver/ses`                      | all (Web-Crypto)   |      ✓      | ✓ (seq) |     –      |      –      |     –     |  ✓   |    –    |
| `unemail/driver/sendgrid`                 | all                |      ✓      |    –    |     ✓      |      –      |     ✓     |  ✓   |    –    |
| `unemail/driver/mailgun`                  | all                |      ✓      |    –    |     ✓      |      –      |     –     |  ✓   |    –    |
| `unemail/driver/mailtrap`                 | all                |      ✓      |    ✓    |     –      |      –      |     ✓     |  ✓   |    –    |
| `unemail/driver/brevo`                    | all                |      ✓      |    –    |     ✓      |      –      |     ✓     |  ✓   |    –    |
| `unemail/driver/mailersend`               | all                |      ✓      |    ✓    |     ✓      |      –      |     –     |  ✓   |    –    |
| `unemail/driver/loops`                    | all                |      –      |    –    |     –      |      –      |     ✓     |  ✓   |    –    |
| `unemail/driver/zeptomail`                | all                |      ✓      |    –    |     –      |      –      |     –     |  –   |    –    |
| `unemail/driver/mailchannels`             | all (CF Workers)   |      ✓      |    –    |     –      |      –      |     –     |  –   |    –    |
| `unemail/driver/cloudflare-email`         | CF Workers binding |      ✓      |    –    |     –      |      –      |     –     |  –   |    –    |
| `unemail/driver/cloudflare-email-service` | CF Workers binding |      ✓      |    –    |     –      |      –      |     –     |  –   |    –    |
| `unemail/driver/http`                     | all                |  (custom)   |    –    |  (custom)  |      –      |     –     |  –   |    –    |

### Mailtrap (Email API + Email Sandbox)

The Mailtrap driver uses one API token for both environments. Email API sends
go to `send.api.mailtrap.io`; Email Sandbox (test inbox capture) uses
`sandbox.api.mailtrap.io` with your inbox ID in the path.

```ts
import { createEmail } from "unemail"
import mailtrap from "unemail/driver/mailtrap"

const email = createEmail({
  driver: mailtrap({
    apiKey: process.env.MAILTRAP_API_KEY!,
    inboxId: process.env.MAILTRAP_INBOX_ID,
    sandbox: process.env.MAILTRAP_USE_SANDBOX === "true",
  }),
})

// Sandbox (captured in test inbox)
await email.send({ from: "a@b.com", to: "c@d.com", subject: "x", text: "hi", sandbox: true })

// Email API
await email.send({ from: "a@verified.com", to: "c@d.com", subject: "x", text: "hi" })
```

Set `msg.sandbox` per message to override the driver default. `sendBatch`
works in both modes; all messages in one batch must target the same environment.
Sandbox sends require `inboxId` (from `mailtrap.io/sandboxes/{id}`).

### Cloudflare: Email Routing vs Email Service

Cloudflare exposes two send APIs on the same `send_email` binding, so there are
two drivers:

- `unemail/driver/cloudflare-email` — **Email Routing**. Builds raw RFC 5322 and
  hands it to `EmailMessage` from the virtual `cloudflare:email` module. Single
  recipient per send, by construction.
- `unemail/driver/cloudflare-email-service` — **Email Service** (Email Sending).
  Passes structured fields. No ambient global, no virtual module, no MIME
  builder in your bundle; multiple recipients in one call.

```ts
import { createEmail } from "unemail"
import cloudflareEmailService from "unemail/driver/cloudflare-email-service"

export default {
  async fetch(req: Request, env: Env) {
    const email = createEmail({ driver: cloudflareEmailService({ binding: env.EMAIL }) })
    await email.send({
      from: { email: "welcome@yourdomain.com", name: "Acme" },
      to: ["a@example.com", "b@example.com"],
      subject: "Welcome",
      html: "<h1>Welcome</h1>",
      text: "Welcome",
    })
    return new Response("ok")
  },
}
```

Needs `"send_email": [{ "name": "EMAIL" }]` in `wrangler.jsonc` and a sender
domain onboarded with `wrangler email sending enable <domain>`. Combined
`to` + `cc` + `bcc` is capped at 50 addresses per send by the provider; the
binding's `E_*` errors are mapped onto the [error taxonomy](#error-taxonomy),
so rate limits stay retryable while validation failures do not.

### Meta drivers

These wrap other drivers:

- `unemail/driver/fallback` — try a list of drivers in order
- `unemail/driver/round-robin` — cycle sends across drivers (with weights)

## Authoring a custom driver

```ts
import { defineDriver, type EmailDriver } from "unemail"

interface MyOptions {
  apiKey: string
  endpoint?: string
}

export default defineDriver<MyOptions>((opts) => ({
  name: "my-driver",
  options: opts,
  flags: {
    attachments: true,
    html: true,
    text: true,
    replyTo: true,
  },
  async initialize() {
    // Optional: open connections, refresh tokens, etc.
  },
  async isAvailable() {
    return Boolean(opts?.apiKey)
  },
  async send(msg, _ctx) {
    const res = await fetch(opts!.endpoint ?? "https://api.example.com/send", {
      method: "POST",
      headers: { authorization: `Bearer ${opts!.apiKey}` },
      body: JSON.stringify(msg),
    })
    if (!res.ok) {
      return {
        data: null,
        error: new Error(`HTTP ${res.status}`) as never, // use createError for code taxonomy
      }
    }
    const body = (await res.json()) as { id: string }
    return {
      data: { id: body.id, driver: "my-driver", at: new Date() },
      error: null,
    }
  },
  async dispose() {
    // Optional: close connections, flush queues.
  },
}))
```

## Error taxonomy

`EmailError` carries a `code` that's stable across drivers:

| Code              | Meaning                                        | Retryable? |
| ----------------- | ---------------------------------------------- | :--------: |
| `INVALID_OPTIONS` | user input is wrong (missing field, bad shape) |     no     |
| `NETWORK`         | transient network or 5xx                       |    yes     |
| `AUTH`            | bad credentials                                |     no     |
| `RATE_LIMIT`      | 429 or provider rate-limit                     |    yes     |
| `TIMEOUT`         | client-side timeout fired                      |    yes     |
| `PROVIDER`        | the provider rejected the message              |     no     |
| `UNSUPPORTED`     | driver can't do this (e.g. SMTP on Workers)    |     no     |
| `CANCELLED`       | abort signal or pool disposed                  |     no     |

Use `createError(driver, code, message, { status, retryable, cause })`.
The retry middleware honors `error.retryable` and Mailgun-style
`Retry-After` headers.
