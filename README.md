# unemail

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

> Driver-based, zero-dependency TypeScript email library. Send, batch, schedule,
> dedupe, render, parse, and verify — with one unified API across every runtime.

## Design goals

| Goal                         | How `unemail` delivers                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One API, many transports** | `createEmail({ driver })` — 15+ built-in drivers (SMTP, Resend, SES, Postmark, SendGrid, Mailgun, Brevo, MailerSend, Loops, Zeptomail, MailChannels, Cloudflare Email, …) |
| **Cross-runtime**            | Node, Bun, Deno, Cloudflare Workers, browser — core is zero-dep and Web-API only                                                                                          |
| **Resilient by default**     | Built-in idempotency keys, retry, rate-limit, circuit breaker, provider fallback                                                                                          |
| **Modern DX**                | `{ data, error }` discriminated union, TypeScript-first, `react:` prop for React Email                                                                                    |
| **Unified observability**    | Structured logging, OpenTelemetry spans, normalized webhook + inbound schema across providers                                                                             |
| **Testing-first**            | `createTestEmail()` with `inbox` + `waitFor` + Vitest matchers                                                                                                            |

## Install

```bash
pnpm add unemail
```

Rendering, queue, and inbound entries have optional peer deps you pull
in only when you use them:

```bash
pnpm add @react-email/render   # only if you import unemail/render/react
pnpm add postal-mime            # only if you import unemail/parse
pnpm add @opentelemetry/api     # only if you pipe withTelemetry to a real tracer
```

## Hello world

```ts
import { createEmail } from "unemail"
import resend from "unemail/drivers/resend"

const email = createEmail({ driver: resend({ apiKey: process.env.RESEND_KEY! }) })

const { data, error } = await email.send({
  from: "Acme <hi@acme.com>",
  to: "user@example.com",
  subject: "Welcome",
  text: "Thanks for signing up.",
})

if (error) throw error // error: EmailError — typed { code, status, retryable, ... }
console.log(data.id) // data: EmailResult — TS narrows after the error check
```

Every driver implements the same contract, so swapping providers is a
one-line change. See [docs/drivers.md](./docs/drivers.md) for the
full matrix.

## Message streams (Postmark-style)

```ts
import postmark from "unemail/drivers/postmark"
import ses from "unemail/drivers/ses"

const email = createEmail({ driver: postmark({ token }) })
email.mount("marketing", ses({ region: "us-east-1" }))

await email.send({ stream: "transactional", to, subject, text })
await email.send({ stream: "marketing", to, subject, html })
```

## Idempotency

```ts
const email = createEmail({ driver, idempotency: true })

await email.send({ to, subject: "Welcome", idempotencyKey: `welcome/${userId}` })
await email.send({ to, subject: "Welcome", idempotencyKey: `welcome/${userId}` })
// ^ second call returns the first result without hitting the driver
```

## Rendering (React Email / jsx-email / MJML)

```ts
import { createEmail, withRender } from "unemail"
import reactRender from "unemail/render/react"

const email = createEmail({ driver }).use(withRender(reactRender()))

await email.send({
  from: "Acme <hi@acme.com>",
  to: "user@example.com",
  subject: "Welcome",
  react: <Welcome name="Ada" />, // html + text auto-derived
})
```

More in [docs/rendering.md](./docs/rendering.md).

## Resilience middleware

```ts
import { withRetry, withCircuitBreaker, withRateLimit, withLogger, withTelemetry } from "unemail"
import { trace } from "@opentelemetry/api"

email
  .use(withRetry({ retries: 3, backoff: "exponential" }))
  .use(withRateLimit({ perSecond: 10 }))
  .use(withCircuitBreaker({ threshold: 5, cooldownMs: 30_000 }))
  .use(withLogger({ redactLocalPart: true }))
  .use(withTelemetry({ tracer: trace.getTracer("unemail") }))
```

## Provider fallback

```ts
import fallback from "unemail/drivers/fallback"
import resend from "unemail/drivers/resend"
import ses from "unemail/drivers/ses"

const email = createEmail({
  driver: fallback({
    drivers: [resend({ apiKey: process.env.RESEND_KEY! }), ses({ region: "us-east-1" })],
  }),
})
// Sends go to Resend; on a retryable error unemail fails over to SES.
```

## Background sending (queue)

```ts
import memoryQueue from "unemail/queue/memory"
import { startWorker } from "unemail/queue/worker"

const queue = memoryQueue()
const worker = startWorker(email, queue, { concurrency: 5, maxAttempts: 5 })
worker.start()

await queue.enqueue({ from, to, subject, text })
```

Swap `memoryQueue()` for `unstorageQueue({ storage })` to persist across
restarts on any unstorage driver (Redis, KV, filesystem, …). More in
[docs/queue.md](./docs/queue.md).

## Inbound + webhooks

```ts
import { defineInboundHandler } from "unemail/inbound"
import sendgridInbound from "unemail/inbound/sendgrid"
import cloudflareInbound from "unemail/inbound/cloudflare"

export default defineInboundHandler({
  providers: [sendgridInbound(), cloudflareInbound()],
  onEmail(mail, ctx) {
    console.log(`[${ctx.provider}]`, mail.subject)
  },
})
```

Webhook signatures normalized the same way — see
[docs/webhooks.md](./docs/webhooks.md).

## Testing

```ts
import { createTestEmail } from "unemail/test"

const email = createTestEmail()
await onboardingFlow(email, user)
expect(email.inbox).toHaveLength(2)
expect(email.last?.subject).toMatch(/welcome/i)
```

[docs/testing.md](./docs/testing.md) has `waitFor` + matchers.

## Authoring a driver

```ts
import { defineDriver } from "unemail"

export default defineDriver<{ apiKey: string }>((opts) => ({
  name: "my-driver",
  options: opts,
  flags: { html: true, attachments: true, batch: true },
  async send(msg) {
    const res = await fetch("https://api.example.com/send", {
      method: "POST",
      headers: { authorization: `Bearer ${opts!.apiKey}` },
      body: JSON.stringify(msg),
    })
    if (!res.ok) return { data: null, error: new Error("send failed") as never }
    const body = (await res.json()) as { id: string }
    return {
      data: { id: body.id, driver: "my-driver", at: new Date() },
      error: null,
    }
  },
}))
```

## Docs

- [docs/drivers.md](./docs/drivers.md) — driver matrix + authoring guide + error taxonomy
- [docs/rendering.md](./docs/rendering.md) — React Email / jsx-email / MJML / `defineTemplate`
- [docs/inbound.md](./docs/inbound.md) — `unemail/parse` + unified inbound handler
- [docs/webhooks.md](./docs/webhooks.md) — signature verification for 5 providers
- [docs/testing.md](./docs/testing.md) — `createTestEmail`, `waitFor`, Vitest matchers
- [docs/observability.md](./docs/observability.md) — logging + OpenTelemetry
- [docs/queue.md](./docs/queue.md) — background sending + retries + durability
- [MIGRATION.md](./MIGRATION.md) — upgrading from v0.x

## License

Published under the [MIT](./LICENSE) license. Made by
[@productdevbook](https://github.com/productdevbook) and
[community](https://github.com/productdevbook/unemail/graphs/contributors).

Architecture inspired by [`unjs/unstorage`](https://github.com/unjs/unstorage).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/unemail?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/unemail
[npm-downloads-src]: https://img.shields.io/npm/dm/unemail?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/unemail
[bundle-src]: https://deno.bundlejs.com/badge?q=unemail
[bundle-href]: https://deno.bundlejs.com/badge?q=unemail
[license-src]: https://img.shields.io/github/license/productdevbook/unemail.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/productdevbook/unemail/blob/main/LICENSE
