# unemail

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

> Driver-based, zero-dependency TypeScript email library. Send, batch, schedule,
> dedupe, render, parse, and verify — with one unified API across every runtime.

> [!WARNING]
> **v1.0 is being refactored from scratch.** Track progress in the
> [tracking issue](https://github.com/productdevbook/unemail/issues/24).
> The v0.x API (`createEmailService`, provider pattern) is being replaced
> with a new `createEmail` + driver pattern modeled on
> [`unjs/unstorage`](https://github.com/unjs/unstorage).

## Design goals

| Goal                         | How `unemail` delivers                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| **One API, many transports** | `createEmail({ driver })` — swap SMTP, Resend, SES, Postmark, SendGrid, Mailgun, Brevo, Loops, … |
| **Cross-runtime**            | Node, Bun, Deno, Cloudflare Workers, browser — core is zero-dep and Web-API only                 |
| **Resilient by default**     | Built-in idempotency keys, retry, rate-limit, circuit breaker, provider fallback                 |
| **Modern DX**                | `{ data, error }` discriminated union, TypeScript-first, `react:` prop for React Email           |
| **Unified observability**    | Middleware hooks, OpenTelemetry spans, normalized webhook + inbound schema across providers      |
| **Testing-first**            | `unemail/drivers/mock` with inbox + `waitFor` + snapshot matchers                                |

## Install

```bash
pnpm add unemail@next
```

## Hello world

```ts
import { createEmail } from "unemail"
import mock from "unemail/drivers/mock"

const email = createEmail({ driver: mock() })

const { data, error } = await email.send({
  from: "Acme <hi@acme.com>",
  to: "user@example.com",
  subject: "Welcome",
  text: "Thanks for signing up.",
})

if (error) throw error
console.log(data.id) // mock_1_…
```

Swap `mock` for a real driver when it ships (`unemail/drivers/resend`,
`unemail/drivers/ses`, …). Every driver implements the same contract, so
application code never changes.

## Message streams

```ts
import postmark from "unemail/drivers/postmark"
import ses from "unemail/drivers/ses"

const email = createEmail({ driver: postmark({ token }) }).mount(
  "marketing",
  ses({ region: "us-east-1" }),
)

await email.send({ stream: "marketing", to, subject, html })
```

## Idempotency

```ts
const email = createEmail({ driver, idempotency: true })

await email.send({ to, subject: "Welcome", idempotencyKey: `welcome/${userId}` })
await email.send({ to, subject: "Welcome", idempotencyKey: `welcome/${userId}` })
// ^ second call returns the first result without hitting the driver
```

## Middleware

```ts
email.use({
  beforeSend: (msg, ctx) => {
    ctx.meta.startedAt = Date.now()
  },
  afterSend: (_msg, ctx, result) =>
    logger.info({
      id: result.data?.id,
      ms: Date.now() - Number(ctx.meta.startedAt),
    }),
  onError: async (msg, _ctx, error) => {
    if (error.retryable) return email.send({ ...msg, stream: "fallback" })
  },
})
```

## Authoring a driver

```ts
import { defineDriver } from "unemail"

export default defineDriver<{ apiKey: string }>((opts) => ({
  name: "my-driver",
  options: opts,
  flags: { html: true, batch: true },
  async send(msg) {
    const res = await fetch("https://api.example.com/send", {
      method: "POST",
      headers: { authorization: `Bearer ${opts!.apiKey}` },
      body: JSON.stringify(msg),
    })
    if (!res.ok) return { data: null, error: new Error("send failed") as never }
    const body = await res.json()
    return {
      data: { id: body.id, driver: "my-driver", at: new Date() },
      error: null,
    }
  },
}))
```

## Roadmap

See the [v1.0 tracking issue](https://github.com/productdevbook/unemail/issues/24)
for the full milestone breakdown:

- **v1.0 Architecture Overhaul** — driver interface, `createEmail`, middleware, idempotency, retry
- **v1.0 Provider Coverage** — SMTP, Resend, SES v2, Postmark, SendGrid, Mailgun, Brevo, MailerSend, Loops, Zeptomail, MailCrab, Cloudflare Email, MailChannels + meta drivers (fallback, round-robin, mock, tee)
- **v1.0 Rendering** — React Email, jsx-email, MJML adapters; type-safe templates
- **v1.0 Inbound & Webhooks** — postal-mime wrapper, unified inbound schema, DKIM/SPF/DMARC verify, webhook signature verification for 5 providers
- **v1.0 DX & Testing** — preview CLI, test utilities (`inbox`, `waitFor`, matchers), OpenTelemetry, queue drivers

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
