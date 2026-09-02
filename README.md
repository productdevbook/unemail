<!-- prettier-ignore-start -->
<p align="center">
  <img src=".github/assets/cover.png" alt="unemail" width="100%">
</p>
<!-- prettier-ignore-end -->

# unemail

A driver-based email library for TypeScript. ESM-only, zero runtime
dependencies, and the same code on Node, Bun, Deno, Cloudflare Workers and
the browser.

```ts
import { createEmail } from "unemail"
import resend from "unemail/drivers/resend"

const email = createEmail({
  driver: resend({ apiKey: process.env.RESEND_API_KEY! }),
  defaults: { from: "Acme <hi@acme.com>" },
})

const { data, error } = await email.send({
  to: "ada@example.com",
  subject: "Welcome",
  html: "<p>Glad you are here.</p>",
})

if (error) console.error(error.code, error.message)
else console.log("sent", data.id)
```

## Install

```sh
bun add unemail
# npm install unemail · pnpm add unemail · yarn add unemail
```

```sh
bun add @react-email/render   # only for unemail/render/react
```

Requires Node 20.11+ (or any runtime with `fetch` and Web Crypto). There is
no CommonJS build.

## The idea

Three pieces, and nothing else:

```
your code ──▶ normalize ──▶ middleware ──▶ driver ──▶ provider
              (once)        (a list)       (a transport)
```

**Normalize once.** `email.send()` parses every address, validates the
message, rejects a header containing a line break, and derives
`List-Unsubscribe`. Drivers receive a frozen `NormalizedMessage` — which is
why no driver in this repo parses an address, and why your message object
is never written back into.

**One kind of middleware.** Retry, logging, rate limiting, the circuit
breaker and idempotency are all the same shape:

```ts
type SendHandler = (msgs, ctx) => Promise<Result<EmailResult>[]>
type Middleware = { name: string; handle: (next: SendHandler) => SendHandler }
```

**The unit of work is a list.** `send()` is the one-element case. This is
what lets retry re-send _only_ the messages that failed — even when the
driver reached the provider in a single batched request. A partial batch
failure costs one small retry instead of a full re-send with duplicate
deliveries.

## Sending

### One message

```ts
const { data, error } = await email.send({
  to: ["ada@example.com", { email: "bob@example.com", name: "Bob" }],
  cc: "Cee <cee@example.com>",
  subject: "Your invoice",
  text: "Attached.",
  html: "<p>Attached.</p>",
  preheader: "Invoice #1042 · due in 14 days",
  attachments: [{ filename: "invoice.pdf", content: bytes, contentType: "application/pdf" }],
  // A string attachment is text unless you say `encoding: "base64"` —
  // the library will not guess, because "test" is valid as both.
  tags: [{ name: "campaign", value: "billing" }],
})
```

`error` is an `EmailError` with a stable `code` (`AUTH`, `RATE_LIMIT`,
`NETWORK`, `TIMEOUT`, `PROVIDER`, `INVALID_OPTIONS`, `UNSUPPORTED`,
`CANCELLED`) and a `retryable` flag that means the same thing whichever
provider produced it.

### Many messages

`sendBatch` never short-circuits. `results[i]` always corresponds to
`messages[i]`:

```ts
const batch = await email.sendBatch(users.map((u) => ({ to: u.email, subject, html })))

batch.ok // false if any failed
batch.sent // the EmailResults that got through
batch.failed // [{ index, error }] for the rest
```

One invalid address in a batch of a thousand fails its own slot and nothing
else.

### Very many messages

```ts
for await (const result of email.sendStream(rowsFromDatabase(), { chunkSize: 100 })) {
  if (result.error) await recordFailure(result.error)
}
```

Accepts a sync or async iterable, so the source can be a cursor. Nothing
larger than a chunk is held in memory.

## Middleware

Registered outermost-first:

```ts
import {
  withCircuitBreaker,
  withLogger,
  withRateLimit,
  withRetry,
  rateLimitPresets,
} from "unemail/middleware"

const email = createEmail({
  driver: resend({ apiKey }),
  defaults: { from },
  use: [
    withLogger(), // measures everything below, retries included
    withCircuitBreaker({ threshold: 5 }), // stops calling a provider that is down
    withRetry({ retries: 3 }), // re-sends only the failures
    withRateLimit(rateLimitPresets.resend), // one token per message, batches included
  ],
})
```

| Middleware           | What it does                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `withRetry`          | Retries the failed indices with backoff. Honors the provider's `Retry-After`.                        |
| `withRateLimit`      | Token bucket, one per destination. A 500-message batch takes 500 tokens, not one.                    |
| `withCircuitBreaker` | Opens after N failures, per destination, probing once after the reset window. Ignores caller errors. |
| `withLogger`         | One structured entry per pipeline trip. Redacts recipients by default.                               |
| `withIdempotency`    | Returns the previous result for a repeated `idempotencyKey`. Only remembers successes.               |

### Writing one

```ts
import { defineMiddleware } from "unemail"

const stamp = defineMiddleware(
  "stamp",
  (next) => (msgs, ctx) =>
    next(
      msgs.map((m) => ({ ...m, headers: { ...m.headers, "X-Sent-By": "acme" } })),
      ctx,
    ),
)

email.use(stamp)
```

Return one result per message. If yours throws, or returns the wrong
number, the core reports it per message instead of losing the batch.

Anything a middleware leaves on `ctx.meta` comes back to the caller, on the
`EmailResult` for a success and on the `EmailError` for a failure:

```ts
email.use(
  defineMiddleware("timing", (next) => async (msgs, ctx) => {
    const start = Date.now()
    const results = await next(msgs, ctx)
    ctx.meta.durationMs = Date.now() - start
    return results
  }),
)

const { data } = await email.send(msg)
data?.meta?.durationMs
```

Middleware registered with `use()` wraps every mounted driver, so anything
stateful — the token bucket, the breaker's failure count — is kept per
destination. A failing Resend opens Resend's circuit and leaves a mounted
SES free to send.

## Drivers

| Driver             | Import                                     | Notes                                                     |
| ------------------ | ------------------------------------------ | --------------------------------------------------------- |
| Resend             | `unemail/drivers/resend`                   | Native batch, scheduling, cancel, retrieve                |
| Postmark           | `unemail/drivers/postmark`                 | Message streams, templates, per-message batch errors      |
| Amazon SES         | `unemail/drivers/ses`                      | SigV4 over Web Crypto — no `@aws-sdk/*`                   |
| SendGrid           | `unemail/drivers/sendgrid`                 | Personalization batching, cancellable schedules           |
| Mailgun            | `unemail/drivers/mailgun`                  | Multipart, recipient-variables batching, EU region        |
| Brevo              | `unemail/drivers/brevo`                    | `messageVersions` batching, cancel, retrieve              |
| MailerSend         | `unemail/drivers/mailersend`               | Bulk endpoint, per-recipient personalization              |
| Mailtrap           | `unemail/drivers/mailtrap`                 | Email API, Sandbox and bulk streams                       |
| ZeptoMail          | `unemail/drivers/zeptomail`                | Batch by address count, rich error codes                  |
| MailChannels       | `unemail/drivers/mailchannels`             | One-request batching, per-tenant DKIM                     |
| Loops              | `unemail/drivers/loops`                    | Transactional-only; no free-form body                     |
| Cloudflare Routing | `unemail/drivers/cloudflare-email`         | The legacy raw-MIME binding                               |
| Cloudflare Service | `unemail/drivers/cloudflare-email-service` | The structured binding                                    |
| Cloudflare REST    | `unemail/drivers/cloudflare-email-rest`    | Same service, outside a Worker                            |
| SMTP               | `unemail/drivers/smtp`                     | Own protocol implementation, pooling, DKIM. Node/Bun only |
| Mailcrab           | `unemail/drivers/mailcrab`                 | Local catcher, with an inbox you can assert against       |
| HTTP               | `unemail/drivers/http`                     | Any endpoint, in ten lines                                |
| Mock               | `unemail/drivers/mock`                     | Records instead of sending                                |
| Fallback           | `unemail/drivers/fallback`                 | Composite: try each provider in turn                      |
| Round-robin        | `unemail/drivers/round-robin`              | Composite: spread across providers                        |
| Tee                | `unemail/drivers/tee`                      | Composite: mirror the same send to several                |

A driver advertises what it can do, so you gate on capability rather than
on a name:

```ts
if (email.driver.features?.scheduling) await email.send({ ...msg, scheduledAt })
```

The core reads the same declaration. Asking a driver for something it has
said it cannot do returns `UNSUPPORTED` instead of sending a message with
the important part missing.

### Failover

```ts
import { wrap } from "unemail"
import { fallback } from "unemail/drivers/fallback"

const driver = fallback([
  wrap(resend({ apiKey }), withRetry()), // retries within the leg
  ses({ region: "eu-central-1" }), // only sees what Resend could not send
])
```

Failover is per message. If 3 of 500 fail at the primary, only those 3 go
to the secondary — nobody receives the same mail twice.

### Streams

```ts
const email = createEmail({
  driver: postmark({ token, messageStream: "outbound" }),
  mounts: { broadcast: postmark({ token: broadcastToken, messageStream: "broadcast" }) },
  defaults: { from },
})

await email.send({ ...msg, stream: "broadcast" })
```

A batch spanning several streams is split across their drivers and
reassembled in order.

### Writing one

```ts
import { defineDriver, ok, err, createError } from "unemail"

export default defineDriver<{ apiKey: string }>((options) => ({
  name: "acme",
  features: { html: true, text: true },
  async send(msg) {
    const response = await fetch("https://api.acme.com/send", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        to: msg.to.map((a) => a.email),
        subject: msg.subject,
        html: msg.html,
      }),
    })
    if (!response.ok) return err(createError("acme", "PROVIDER", `HTTP ${response.status}`))
    const body = await response.json()
    return ok({ id: body.id, driver: "acme", at: new Date() })
  },
}))
```

`msg` arrives normalized. Add `sendBatch` only if the provider has a real
batch endpoint — it must return one result per input, in order.

## Rendering

`message.content` is opaque to the core; a renderer claims it by `type`.
Adding a template language is a package, not a core change.

```ts
import { withRender } from "unemail/render"
import reactRenderer from "unemail/render/react"

email.use(withRender(reactRenderer()))

await email.send({
  to,
  subject: "Welcome",
  content: { type: "react", element: <Welcome name="Ada" /> },
})
```

The plain-text alternative is derived from the HTML unless you set `text`
or the renderer produces one. Your message object is never mutated.

```ts
import { defineTemplate } from "unemail/render"

const welcome = defineTemplate<{ name: string }>(({ name }) => ({
  subject: `Welcome, ${name}`,
  content: { type: "react", element: <Welcome name={name} /> },
}))

await email.send({ to, ...welcome({ name: "Ada" }) })
```

Your own renderer:

```ts
import type { Renderer } from "unemail/render"

const markdown: Renderer = {
  name: "markdown",
  type: "markdown",
  render: (content) => ({ html: toHtml(content.source as string) }),
}
```

## Testing

```ts
import { createEmail } from "unemail"
import mock from "unemail/drivers/mock"

const driver = mock()
const email = createEmail({ driver, defaults: { from: "hi@acme.com" } })

await email.send({ to: "ada@example.com", subject: "hi", text: "hello" })

const inbox = driver.getInstance()
inbox.last()?.subject // "hi"
inbox.find("ada@example.com") // every message addressed to Ada
```

Simulate failures without a network:

```ts
mock({ fail: { code: "RATE_LIMIT" } }) // everything fails
mock({ failWhen: (msg, i) => i === 1 }) // partial batch failure
mock({ latencyMs: 50 }) // slow provider
```

## API

### `createEmail(options)`

| Option     | Type                                                 |                                    |
| ---------- | ---------------------------------------------------- | ---------------------------------- |
| `driver`   | `EmailDriver`                                        | Required                           |
| `mounts`   | `Record<string, EmailDriver>`                        | Routed by `message.stream`         |
| `use`      | `Middleware[]`                                       | Outermost first                    |
| `defaults` | `{ from, replyTo, headers, tags, metadata, stream }` | Applied to messages that omit them |
| `signal`   | `AbortSignal`                                        | Cancels in-flight sends            |

Returns an `Email` with `send`, `sendBatch`, `sendStream`, `cancel`,
`retrieve`, `use`, `mount`, `unmount`, `getMount`, `getMounts`,
`isAvailable` and `dispose`.

`cancel` and `retrieve` return `UNSUPPORTED` on a driver that lacks them,
rather than throwing.

### Message

`from` `to` `cc` `bcc` `replyTo` `subject` `preheader` `text` `html`
`content` `headers` `attachments` `tags` `metadata` `idempotencyKey`
`scheduledAt` `unsubscribe` `template` `tracking` `sandbox` `raw` `stream`

Addresses accept `"a@b.com"`, `"Ada <a@b.com>"`, `{ email, name }`, or a
list of any of those.

## Compatibility

| Runtime            | Core | HTTP drivers | SMTP |
| ------------------ | ---- | ------------ | ---- |
| Node 20.11+        | ✅   | ✅           | ✅   |
| Bun                | ✅   | ✅           | ✅   |
| Deno               | ✅   | ✅           | —    |
| Cloudflare Workers | ✅   | ✅           | —    |
| Browser            | ✅   | ✅           | —    |

SMTP needs `node:net` and `node:tls`. Everything else is `fetch` and Web
Crypto.

## Docs

- [Architecture](./docs/architecture.md) — the pipeline, and why the unit of
  work is a list
- [Drivers](./docs/drivers.md) — every option, provider quirks, capability
  matrix
- [Benchmarks](./docs/benchmarks.md) — what the pipeline costs, measured
- [Migration](./MIGRATION.md) — upgrading from 0.5 or 0.6

## Upgrading

0.6 was a rewrite; 0.7 adds seven drivers and four core changes. See
[MIGRATION.md](./MIGRATION.md).

## Contributing

```sh
bun install
bun run check     # lint, typecheck, tests + coverage, version consistency
bun run build
bun run bench     # see docs/benchmarks.md
```

## License

[MIT](./LICENSE) © [productdevbook](https://github.com/productdevbook)
