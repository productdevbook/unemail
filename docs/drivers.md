# Drivers

Every transport in unemail is a driver — a small module conforming to
`EmailDriver`. You wire one into `createEmail({ driver })` and never
touch it again; swapping providers is a one-line change.

## Built-in drivers

| Sub-path                           | Runtime            | Attachments |  Batch  | Scheduling | Idempotency | Templates | Tags | Streams |
| ---------------------------------- | ------------------ | :---------: | :-----: | :--------: | :---------: | :-------: | :--: | :-----: |
| `unemail/drivers/mock`             | all                |      ✓      |    ✓    |     ✓      |      ✓      |     –     |  ✓   |    –    |
| `unemail/drivers/smtp`             | Node + Bun         |      ✓      | ✓ (seq) |     –      |      –      |     –     |  –   |    –    |
| `unemail/drivers/mailcrab`         | Node (local only)  |      ✓      |    ✓    |     –      |      –      |     –     |  –   |    –    |
| `unemail/drivers/resend`           | all                |      ✓      |    ✓    |     ✓      |      ✓      |     ✓     |  ✓   |    –    |
| `unemail/drivers/postmark`         | all                |      ✓      |    ✓    |     –      |      –      |     ✓     |  ✓   |    ✓    |
| `unemail/drivers/ses`              | all (Web-Crypto)   |      ✓      | ✓ (seq) |     –      |      –      |     –     |  ✓   |    –    |
| `unemail/drivers/sendgrid`         | all                |      ✓      |    –    |     ✓      |      –      |     ✓     |  ✓   |    –    |
| `unemail/drivers/mailgun`          | all                |      ✓      |    –    |     ✓      |      –      |     –     |  ✓   |    –    |
| `unemail/drivers/brevo`            | all                |      ✓      |    –    |     ✓      |      –      |     ✓     |  ✓   |    –    |
| `unemail/drivers/mailersend`       | all                |      ✓      |    ✓    |     ✓      |      –      |     –     |  ✓   |    –    |
| `unemail/drivers/loops`            | all                |      –      |    –    |     –      |      –      |     ✓     |  ✓   |    –    |
| `unemail/drivers/zeptomail`        | all                |      ✓      |    –    |     –      |      –      |     –     |  –   |    –    |
| `unemail/drivers/mailchannels`     | all (CF Workers)   |      ✓      |    –    |     –      |      –      |     –     |  –   |    –    |
| `unemail/drivers/cloudflare-email` | CF Workers binding |      ✓      |    –    |     –      |      –      |     –     |  –   |    –    |
| `unemail/drivers/http`             | all                |  (custom)   |    –    |  (custom)  |      –      |     –     |  –   |    –    |

### Meta drivers

These wrap other drivers:

- `unemail/drivers/fallback` — try a list of drivers in order
- `unemail/drivers/round-robin` — cycle sends across drivers (with weights)

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
