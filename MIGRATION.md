# Migrating from v0.x to v1.0

v1 is a full rewrite. The provider pattern was replaced with a driver-based
architecture modeled on [`unjs/unstorage`](https://github.com/unjs/unstorage),
the error shape is a proper discriminated union, and every provider now
runs unchanged on Node, Bun, Deno, Cloudflare Workers, and the browser.

This guide walks through the breaking changes with before/after snippets.

## At a glance

| Concern             | v0.x                               | v1.0                                                                      |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| Factory             | `createEmailService({ provider })` | `createEmail({ driver })`                                                 |
| Provider definition | `defineProvider(factory)`          | `defineDriver(factory)` (identical ergonomics, renamed for consistency)   |
| Import path         | `unemail/providers/<name>`         | `unemail/drivers/<name>`                                                  |
| Result shape        | `{ success, data?, error? }`       | `{ data, error: null } \| { data: null, error: EmailError }` (narrowable) |
| Error type          | plain `Error`                      | `EmailError` with `code` taxonomy + `retryable` flag                      |
| Runtime             | Node-only for most providers       | Node + Bun + Deno + Workers + browser for every HTTP driver               |
| Rendering           | manual `html` / `text`             | `email.use(withRender(reactRender()))` + `send({ react: <Welcome/> })`    |
| Testing             | stub the provider yourself         | `createTestEmail()` with `.inbox` + `waitFor` + Vitest matchers           |

## Step-by-step

### 1. Install the new entry points

```bash
pnpm remove unemail
pnpm add unemail@next
```

### 2. Replace `createEmailService` with `createEmail`

```diff
- import { createEmailService } from "unemail"
- import resendProvider from "unemail/providers/resend"
+ import { createEmail } from "unemail"
+ import resend from "unemail/drivers/resend"

- const email = createEmailService({
-   provider: resendProvider({ apiKey: process.env.RESEND_KEY! }),
- })
+ const email = createEmail({
+   driver: resend({ apiKey: process.env.RESEND_KEY! }),
+ })
```

### 3. Update your Result handling

```diff
- const result = await email.sendEmail(msg)
- if (result.success) {
-   console.log(result.data!.messageId)
- } else {
-   console.error(result.error!.message)
- }
+ const { data, error } = await email.send(msg)
+ if (error) {
+   console.error(error.message)  // error.code, error.status, error.retryable also typed
+   return
+ }
+ console.log(data.id)             // TS narrows — data is non-null here
```

### 4. Rename custom provider implementations

```diff
- import { defineProvider } from "unemail"
+ import { defineDriver } from "unemail"

- export default defineProvider((options) => ({
-   name: "my-provider",
-   async initialize() { ... },
-   async isAvailable() { ... },
-   async sendEmail(msg) { ... },
- }))
+ export default defineDriver((options) => ({
+   name: "my-driver",
+   async initialize() { ... },
+   async isAvailable() { ... },
+   async send(msg, ctx) { ... },
+ }))
```

`send` now takes a second `ctx` argument with `driver`, `stream`, `attempt`,
`signal`, and `meta` fields (middleware chain context).

### 5. Replace your ad-hoc provider mocks

```diff
- const spy = vi.fn()
- const email = createEmailService({
-   provider: { name: "test", initialize: () => {}, isAvailable: () => true,
-     sendEmail: spy, features: {} } as any,
- })
+ import { createTestEmail } from "unemail/test"
+ const email = createTestEmail()
+ // …run your code…
+ expect(email.inbox).toHaveLength(1)
+ expect(email.last?.subject).toMatch(/welcome/i)
```

### 6. Provider-specific fields removed from the base message

These fields existed as top-level message options in v0.x:

- `useDkim`, `dsn`, `priority`, `inReplyTo`, `references`, `listUnsubscribe`,
  `googleMailHeaders` (all SMTP-only)
- `customParams`, `endpointOverride`, `methodOverride` (HTTP-only)
- `templateId`, `templateData`, `scheduledAt`, `tags` (Resend)
- `configurationSetName`, `messageTags`, `sourceArn` (SES)
- `trackClicks`, `trackOpens`, `clientReference`, `mimeHeaders` (Zeptomail)

In v1 the base message stays narrow. Anything not in the core shape goes
through `msg.headers`, the driver's options (driver-scoped), or `msg.tags`.

```diff
- await email.sendEmail({ ..., priority: "high" })
+ await email.send({ ..., headers: { "X-Priority": "1" } })
```

### 7. Retries and timeouts moved to middleware

```diff
- const email = createEmailService({
-   provider: smtp(...),
-   retries: 3,
-   timeout: 5000,
- })
+ import { withRetry } from "unemail"
+ const email = createEmail({ driver: smtp({ commandTimeoutMs: 5000 }) })
+ email.use(withRetry({ retries: 3 }))
```

### 8. New capabilities you probably want

- **Idempotency**: `createEmail({ driver, idempotency: true })` plus
  `send({ idempotencyKey })` dedupes across retries and crashes. Works
  with any driver; Resend/Postmark native headers used where available.
- **Streams**: `email.mount("marketing", ses(...))` then
  `send({ stream: "marketing", ... })` — route by purpose without
  juggling multiple `Email` instances.
- **Fallback**: `fallback({ drivers: [resend(...), ses(...)] })` tries
  each driver in order on retryable failures.
- **Rendering**: `email.use(withRender(reactRender()))` and pass
  `react: <Welcome/>` directly to `send()`.

## Provider migration table

| v0.x import                   | v1.0 import                        |
| ----------------------------- | ---------------------------------- |
| `unemail/providers/smtp`      | `unemail/drivers/smtp`             |
| `unemail/providers/resend`    | `unemail/drivers/resend`           |
| `unemail/providers/aws-ses`   | `unemail/drivers/ses` (now SES v2) |
| `unemail/providers/http`      | `unemail/drivers/http`             |
| `unemail/providers/zeptomail` | `unemail/drivers/zeptomail`        |
| (MailCrab helper only in v0)  | `unemail/drivers/mailcrab`         |

New in v1: `postmark`, `sendgrid`, `mailgun`, `brevo`, `mailersend`,
`loops`, `mailchannels`, `cloudflare-email`, plus meta drivers
`mock`, `fallback`, `round-robin`.

## Feature flag matrix

Each driver advertises what it supports via `driver.flags`. See
`docs/drivers.md` for the full matrix.
