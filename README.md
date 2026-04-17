<p align="center">
  <br>
  <img src="https://raw.githubusercontent.com/productdevbook/unemail/main/.github/assets/cover.png" alt="unemail — One API for every email provider" width="100%">
  <br><br>
  <b style="font-size: 2em;">unemail</b>
  <br><br>
  Driver-based, zero-dependency TypeScript email library.
  <br>
  Send, batch, schedule, dedupe, render, parse, verify, and sign — one unified API across every runtime.
  <br><br>
  <a href="https://npmjs.com/package/unemail"><img src="https://img.shields.io/npm/v/unemail?style=flat&colorA=18181B&colorB=F0DB4F" alt="npm version"></a>
  <a href="https://npmjs.com/package/unemail"><img src="https://img.shields.io/npm/dm/unemail?style=flat&colorA=18181B&colorB=F0DB4F" alt="npm downloads"></a>
  <a href="https://bundlephobia.com/result?p=unemail"><img src="https://img.shields.io/bundlephobia/minzip/unemail?style=flat&colorA=18181B&colorB=F0DB4F" alt="bundle size"></a>
  <a href="https://github.com/productdevbook/unemail/blob/main/LICENSE"><img src="https://img.shields.io/github/license/productdevbook/unemail?style=flat&colorA=18181B&colorB=F0DB4F" alt="license"></a>
  <a href="https://github.com/sponsors/productdevbook"><img src="https://img.shields.io/github/sponsors/productdevbook?style=flat&colorA=18181B&colorB=F0DB4F&label=sponsors" alt="sponsors"></a>
</p>

## Design goals

| Goal                         | How `unemail` delivers                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One API, many transports** | `createEmail({ driver })` — 15+ built-in drivers (SMTP, Resend, SES, Postmark, SendGrid, Mailgun, Brevo, MailerSend, Loops, Zeptomail, MailChannels, Cloudflare Email, …) |
| **Cross-runtime**            | Node, Bun, Deno, Cloudflare Workers, browser — core is zero-dep and Web-API only. No `axios`, ever.                                                                       |
| **Compliance-ready**         | RFC 8058 one-click List-Unsubscribe, DKIM + ARC signing, suppression/preference stores, DMARC + TLS-RPT + ARF parsers                                                     |
| **Resilient by default**     | Idempotency, retry w/ jitter, per-provider rate-limit, circuit breaker, dedupe, dead-letter, provider fallback                                                            |
| **Unified observability**    | Structured logging, OpenTelemetry, Prometheus metrics, normalized `EmailEvent` stream across send + webhook paths                                                         |
| **Modern DX**                | `{ data, error }` Result discriminated union, typed `Address` primitive, `react:`/`mjml:`/`handlebars:`/`liquid:` props                                                   |
| **Testing-first**            | `createTestEmail()` with inbox + `waitFor` + 5 Vitest matchers + snapshot helper                                                                                          |

## Install

```bash
pnpm add unemail
```

Rendering, queue, and parser entries pull in optional peer deps only
when you import them:

```bash
pnpm add @react-email/render   # unemail/render/react
pnpm add mjml                  # unemail/render/mjml
pnpm add handlebars            # unemail/render/handlebars
pnpm add liquidjs              # unemail/render/liquid
pnpm add juice                 # htmlPipeline(inlineCss())
pnpm add postal-mime           # unemail/parse
pnpm add @opentelemetry/api    # withTelemetry
pnpm add unstorage             # unstorageQueue / unstorageSuppressionStore
pnpm add bullmq                # unemail/queue/bullmq
pnpm add pg-boss               # unemail/queue/pg-boss
```

## Hello world

```ts
import { createEmail } from "unemail"
import resend from "unemail/driver/resend"

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
one-line change.

## Message streams (Postmark-style)

```ts
import postmark from "unemail/driver/postmark"
import ses from "unemail/driver/ses"

const email = createEmail({ driver: postmark({ token }) })
email.mount("marketing", ses({ region: "us-east-1" }))

await email.send({ stream: "transactional", to, subject, text })
await email.send({ stream: "marketing", to, subject, html })
```

## Deliverability & compliance

**Gmail + Yahoo 2024 bulk-sender compliance is one line:**

```ts
await email.send({
  from,
  to,
  subject,
  html,
  unsubscribe: {
    url: `https://app.com/u?t=${token}`, // RFC 8058 one-click
    mailto: "unsubscribe@acme.com",
  },
})
// → auto-injects List-Unsubscribe + List-Unsubscribe-Post headers.
```

**DKIM sign outbound SMTP** (RSA or Ed25519, pure Web-Crypto):

```ts
import smtp from "unemail/driver/smtp"
const driver = smtp({
  host: "smtp.acme.com",
  dkim: { selector: "s1", domain: "acme.com", privateKey: pem },
})
```

**Suppression + preferences** stop sends before they hit the provider:

```ts
import { withSuppression } from "unemail/middleware"
import { memorySuppressionStore } from "unemail/suppression"

const store = memorySuppressionStore()
// webhook handler → store.add(recipient, "bounce")
const email = createEmail({ driver: withSuppression(resend({ apiKey }), { store }) })
```

**Other deliverability utilities:**

- `unemail/verify/arc` — ARC-Set signer (RFC 8617) for forwarders
- `unemail/dmarc` — aggregate (RUA) XML + gzip parser
- `unemail/mta-sts` — policy file generator + TLS-RPT JSON parser
- `unemail/parse/arf` — RFC 5965 feedback-loop (FBL) reports

## Provider-side templates

Eight drivers map `msg.template` into native template APIs:

```ts
await email.send({
  from,
  to,
  subject,
  template: { id: "tpl_welcome", variables: { name: "Ada" } },
})
// → SendGrid dynamic_template_data, Postmark TemplateModel,
//   Mailgun h:X-Mailgun-Variables, Brevo params, MailerSend
//   personalization.data, Loops dataVariables, Zeptomail merge_info.
```

## Personalizations & batch

SendGrid-style per-recipient fan-out — one batched API call when the
driver supports it, or an automatic loop when it doesn't:

```ts
await email.send({
  from,
  subject: "Welcome",
  personalizations: [
    { to: "ada@x.com", variables: { name: "Ada" } },
    { to: "bob@x.com", variables: { name: "Bob" }, subject: "Just for Bob" },
  ],
  template: { id: "tpl_welcome" },
})

// Or stream results for huge fan-outs:
for await (const result of email.sendBatchStream(messages)) {
  if (result.error) report(result.error)
}
```

## Rendering

**React Email / jsx-email / MJML / Handlebars / Liquid** all plug in
as renderers:

```ts
import { createEmail, withRender } from "unemail"
import reactRender from "unemail/render/react"
import { handlebarsRenderer } from "unemail/render/handlebars"

const email = createEmail({ driver }).use(withRender(reactRender(), handlebarsRenderer()))
```

**HTML post-processing pipeline** — preheader, dark-mode, CID
auto-rewrite, juice inlining:

```ts
import {
  htmlPipeline,
  withPreheader,
  cidRewrite,
  darkModeHook,
  inlineCss,
} from "unemail/render/pipeline"

email.use(
  htmlPipeline(
    withPreheader(), // reads msg.preheader
    cidRewrite(), // <img src="logo.png"> → cid:logo
    darkModeHook({ darkCss: "body{background:#000}" }),
    inlineCss(), // peer: juice
  ),
)
```

**i18n** dispatches per-locale renderers:

```ts
import { i18nRenderer } from "unemail/render/i18n"

email.use(
  withRender(
    i18nRenderer({
      fallback: handlebarsRenderer({
        /* defaults */
      }),
      byLocale: {
        tr: handlebarsRenderer({
          /* tr */
        }),
        en: handlebarsRenderer({
          /* en */
        }),
      },
    }),
  ),
)
```

**Calendar invites** (ICS) attach to any message:

```ts
import { icalEvent } from "unemail/ics"

await email.send({
  from,
  to,
  subject: "Design sync",
  text: "...",
  attachments: [
    icalEvent({
      uid: "evt-1@acme.com",
      start: new Date("2026-05-01T10:00:00Z"),
      end: new Date("2026-05-01T11:00:00Z"),
      summary: "Design sync",
      organizer: { email: "host@acme.com" },
      attendees: [{ email: "ada@acme.com", rsvp: true }],
    }),
  ],
})
```

## Resilience middleware

```ts
import {
  withRetry,
  withCircuitBreaker,
  withRateLimit,
  rateLimitPresets,
  withDedupe,
  withLogger,
  withTelemetry,
  withMetrics,
  createMetricsRegistry,
} from "unemail/middleware"
import { trace } from "@opentelemetry/api"

const metrics = createMetricsRegistry()

email
  .use(withDedupe({ strategy: "contentHash", ttlSeconds: 60 }))
  .use(withRetry({ retries: 3, backoff: "full-jitter", deadLetter: dlqDriver }))
  .use(withRateLimit(rateLimitPresets.sendgrid()))
  .use(withCircuitBreaker({ threshold: 5, cooldownMs: 30_000 }))
  .use(withLogger({ redactLocalPart: true }))
  .use(withTelemetry({ tracer: trace.getTracer("unemail") }))
  .use(withMetrics({ registry: metrics }))

// Prometheus exposition:
app.get("/metrics", () => new Response(metrics.expose()))
```

### OAuth2 (Gmail / Microsoft 365)

```ts
import { oauth2Gmail } from "unemail/middleware"

email.use(
  oauth2Gmail({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
  }),
)
```

## Provider fallback + composition

```ts
import fallback from "unemail/driver/fallback"
import roundRobin from "unemail/driver/round-robin"
import resend from "unemail/driver/resend"
import ses from "unemail/driver/ses"

const email = createEmail({
  driver: fallback({
    drivers: [resend({ apiKey: process.env.RESEND_KEY! }), ses({ region: "us-east-1" })],
  }),
})
```

## Queues

In-memory / unstorage / BullMQ / pg-boss / AWS SQS all implement the
same `EmailQueue` contract. `msg.scheduledAt` defers the send through
every backend:

```ts
import memoryQueue from "unemail/queue/memory"
import { startWorker } from "unemail/queue/worker"

const queue = memoryQueue()
startWorker(email, queue, { concurrency: 5, maxAttempts: 5 }).start()

await queue.enqueue({
  from,
  to,
  subject,
  scheduledAt: new Date(Date.now() + 60 * 60 * 1000), // send in 1h
})
```

Swap for `bullmqQueue({ bull })`, `pgBossQueue({ boss })`, or
`sqsQueue({ sqs, queueUrl })` for durable multi-process sending.

## Inbound + webhooks

Pre-normalized handlers for Cloudflare Email, Postmark, SendGrid,
Mailgun, and SES (via SNS):

```ts
import { defineInboundHandler } from "unemail/inbound"
import sendgridInbound from "unemail/inbound/sendgrid"
import { defineSesInboundHandler } from "unemail/inbound/ses"

export default defineInboundHandler({
  providers: [sendgridInbound()],
  onEmail(mail) {
    /* ParsedEmail */
  },
})
```

**Reply-only text extraction** (EN/TR/DE/FR/ES):

```ts
import { stripReply } from "unemail/inbound/reply"
import { threadKey } from "unemail/inbound/thread"

const { text, quoted } = stripReply(parsed.text ?? "")
const thread = threadKey(parsed) // canonical root Message-ID
```

**Webhook signature verification** — Resend, Postmark, Mailgun,
SendGrid, SES, plus a zero-dep **Standard Webhooks**
(`standardwebhooks.com`) verifier that's <5 kB (vs Svix's ~1 MB):

```ts
import { verifyStandardWebhook } from "unemail/webhook/standard"

const body = await verifyStandardWebhook(request, {
  secret: process.env.WHSEC!,
})
```

## Unified event stream

Send events + webhook events converge on one `EmailEvent` shape:

```ts
import { EventBus, withEvents, memoryEventStore } from "unemail/events"

const bus = new EventBus()
const store = memoryEventStore()
bus.on((e) => store.append(e))

const email = createEmail({ driver: withEvents(resend({ apiKey }), bus) })

// later:
const timeline = await store.list!(messageId)
// [send.queued, send.attempt, send.success, delivered, opened, ...]
```

## Typed addresses

Validate at system boundaries — rejects malformed input before it
reaches a driver:

```ts
import { parseAddress } from "unemail/address"

const { data, error } = parseAddress("Ada <ada@acme.com>")
if (error) throw error
data.local // "ada"
data.domain // "acme.com"
```

## Testing

```ts
import { createTestEmail, emailMatchers, toEmailSnapshot } from "unemail/test"
import { expect } from "vitest"

expect.extend(emailMatchers)

const email = createTestEmail()
await onboardingFlow(email, user)

expect(email).toHaveSentTo("ada@acme.com")
expect(email).toHaveSentWithSubject(/welcome/i)
expect(email).toHaveSentWithAttachment("invite.ics")
expect(email).toHaveSentMatching((m) => m.metadata?.userId === user.id)
expect(toEmailSnapshot(email.last!)).toMatchSnapshot()
```

## Authoring a driver

```ts
import { defineDriver } from "unemail"

export default defineDriver<{ apiKey: string }>((opts) => ({
  name: "my-driver",
  options: opts,
  flags: { html: true, attachments: true, batch: true, cancelable: true },
  async send(msg) {
    const res = await fetch("https://api.example.com/send", {
      method: "POST",
      headers: { authorization: `Bearer ${opts!.apiKey}` },
      body: JSON.stringify(msg),
    })
    if (!res.ok) return { data: null, error: new Error("send failed") as never }
    const body = (await res.json()) as { id: string }
    return { data: { id: body.id, driver: "my-driver", at: new Date() }, error: null }
  },
  async cancel(id) {
    /* optional */
  },
  async retrieve(id) {
    /* optional */
  },
}))
```

## Result helpers

```ts
import { isOk, isErr, unwrap, unwrapOr, mapOk, tryAsync } from "unemail/result"

const res = await email.send({ ... })
if (isOk(res)) console.log(res.data.id)
const id = unwrapOr(res, { id: "offline", driver: "mock", at: new Date() }).id
```

## Docs

- [docs/drivers.md](./docs/drivers.md) — driver matrix + authoring guide + error taxonomy
- [docs/rendering.md](./docs/rendering.md) — React Email / jsx-email / MJML / Handlebars / Liquid / i18n / HTML pipeline
- [docs/inbound.md](./docs/inbound.md) — `unemail/parse` + unified inbound handler + reply stripper + thread stitcher
- [docs/webhooks.md](./docs/webhooks.md) — signature verification for 6 providers + Standard Webhooks
- [docs/deliverability.md](./docs/deliverability.md) — DKIM + ARC + List-Unsubscribe + DMARC + MTA-STS + suppression + preferences
- [docs/testing.md](./docs/testing.md) — `createTestEmail`, `waitFor`, 5 Vitest matchers + snapshots
- [docs/observability.md](./docs/observability.md) — logging + OTel + Prometheus metrics + unified event stream
- [docs/queue.md](./docs/queue.md) — memory / unstorage / BullMQ / pg-boss / SQS
- [docs/rfcs/001-packaging.md](./docs/rfcs/001-packaging.md) — why single package with sub-paths
- [MIGRATION.md](./MIGRATION.md) — upgrading from v0.x

## License

Published under the [MIT](./LICENSE) license. Made by
[@productdevbook](https://github.com/productdevbook) and
[community](https://github.com/productdevbook/unemail/graphs/contributors).

Architecture inspired by [`unjs/unstorage`](https://github.com/unjs/unstorage).
