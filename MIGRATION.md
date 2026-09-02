# Migrating from 0.x to 1.0

v1 is a rewrite. The driver idea survives; almost every signature around it
changed. Read the two sections that apply to you and skip the rest.

## Why

0.x had two composition models side by side — hook-based `Middleware`
(`beforeSend` / `afterSend` / `onError`) and driver decorators
(`withRetry(driver)`). The second existed because retry cannot be written
with the first. v1 has one model, and it operates on a list, which is what
lets retry re-send only the messages that failed.

Four defects came out with the old design:

- `sendBatch` returned on the first failure, losing the results of messages
  that had already been accepted.
- `initialize()` set its "done" flag before awaiting, so concurrent sends
  raced past a half-initialized driver, and a driver mounted after the
  first send was never initialized at all.
- `withRender` mutated the caller's message object, so a reused template
  quietly accumulated `html` and `text` between sends.
- A driver that did not support `personalizations` had all but the first
  silently dropped.

## Scope

**Every 0.x driver is present.** They were dropped in the first v1 commit
and restored immediately after, each one rewritten against the new contract
and checked against the provider's current documentation — which turned up
defects the old versions had been shipping. See `docs/drivers.md`.

These 0.x entry points are **not** in 1.0.0 and are being reintroduced
against the new core:

`unemail/inbound/*` · `unemail/webhook/*` · `unemail/queue/*` ·
`unemail/verify/*` · `unemail/parse/*` · `unemail/dmarc` ·
`unemail/mta-sts` · `unemail/ics` · `unemail/suppression` ·
`unemail/compliance` · `unemail/preferences` · `unemail/events` ·
`unemail/test`.

Pin `unemail@^0.5.0` if you depend on one of those today.

## Import paths

`driver` became `drivers`, matching `unstorage`:

```diff
-import resend from "unemail/driver/resend"
+import resend from "unemail/drivers/resend"
```

Three drivers changed name or gained a sibling:

```diff
-import cloudflareEmail from "unemail/driver/cloudflare-email"
+import cloudflareEmail from "unemail/drivers/cloudflare-email"          // Email Routing, raw MIME
+import cloudflareEmailService from "unemail/drivers/cloudflare-email-service"  // the structured binding
+import cloudflareEmailRest from "unemail/drivers/cloudflare-email-rest"  // the same service over HTTP
```

`mailchannels` now **requires** `apiKey`. The free unauthenticated Workers
integration was terminated in June 2024, so the 0.5 driver could not send at
all.

`unemail/test` is gone; the mock driver carries the inbox now.

## Messages

Renderer-specific fields left the core message type. One `content` block
replaces all of them:

```diff
-await email.send({ from, to, subject, react: <Welcome /> })
+await email.send({ to, subject, content: { type: "react", element: <Welcome /> } })
```

Same for `jsx`, `mjml`, `handlebars` + `handlebarsVars`, and
`liquid` + `liquidVars` — each becomes a `content.type` its renderer claims.

`from` can now come from the instance:

```diff
-await email.send({ from: "Acme <hi@acme.com>", to, subject, text })
+const email = createEmail({ driver, defaults: { from: "Acme <hi@acme.com>" } })
+await email.send({ to, subject, text })
```

Attachments no longer guess. A string is text unless you say otherwise:

```diff
-attachments: [{ filename: "a.pdf", content: alreadyBase64 }]
+attachments: [{ filename: "a.pdf", content: alreadyBase64, encoding: "base64" }]
```

`"test"` is valid text and valid base64, so the old heuristic corrupted short
text attachments silently. Raw bytes are unaffected.

Removed: `personalizations` (use `sendBatch`), `amp`, `dsn`, and
`template.locale`.

New: `preheader` injects a hidden preview line into the HTML, and a header
value containing `\r` or `\n` is now rejected instead of being written into
the message.

## Batches

The return type changed, and it no longer short-circuits:

```diff
-const { data, error } = await email.sendBatch(messages)
-if (error) throw error            // and every accepted message was lost
-console.log(data.length)
+const batch = await email.sendBatch(messages)
+console.log(batch.sent.length, batch.failed.length)
+for (const { index, error } of batch.failed) retryLater(messages[index], error)
```

`batch.results[i]` always corresponds to `messages[i]`.

`sendBatchStream` became `sendStream`, takes a sync or async iterable, and
accepts `{ chunkSize }`:

```diff
-for await (const r of email.sendBatchStream(messages)) …
+for await (const r of email.sendStream(messages, { chunkSize: 100 })) …
```

## Middleware

Hooks are gone. A middleware wraps the next handler:

```diff
-email.use({
-  name: "audit",
-  async beforeSend(msg, ctx) { await log(msg) },
-  async afterSend(msg, ctx, result) { await log(result) },
-})
+email.use(defineMiddleware("audit", (next) => async (msgs, ctx) => {
+  await log(msgs)
+  const results = await next(msgs, ctx)
+  await log(results)
+  return results
+}))
```

`onError` has no direct equivalent — inspect the results after `next` and
return replacements, which is also how you recover.

`withRetry`, `withRateLimit` and `withCircuitBreaker` are middleware now,
not driver decorators:

```diff
-const driver = withRetry(resend({ apiKey }), { retries: 3 })
-const email = createEmail({ driver })
+const email = createEmail({ driver: resend({ apiKey }), use: [withRetry({ retries: 3 })] })
```

To attach one to a single driver — the pattern that made
`fallback([withRetry(a), withRetry(b)])` work — use `wrap`:

```diff
-fallback([withRetry(resend({ apiKey })), withRetry(ses({ region }))])
+fallback([wrap(resend({ apiKey }), withRetry()), wrap(ses({ region }), withRetry())])
```

Idempotency moved out of `createEmail` into middleware:

```diff
-createEmail({ driver, idempotency: { store, ttlSeconds: 3600 } })
+createEmail({ driver, use: [withIdempotency({ store, ttlSeconds: 3600 })] })
```

`withRetry`'s `deadLetter` option is gone. Route failures yourself from
`batch.failed`, or put the dead-letter driver behind `fallback`.

Default backoff changed from `exponential` to `exponential-jitter` — plain
exponential synchronizes every client that failed at the same moment into
the same retry wave.

## Rendering

```diff
-email.use(withRender(reactRenderer()))
+email.use(withRender(reactRenderer()))   // unchanged
```

But a `Renderer` now claims a content type rather than probing the message,
and returns `{ html, text? }` instead of a bare string:

```diff
 const markdown: Renderer = {
   name: "markdown",
-  match: (msg) => msg.markdown != null,
-  render: (msg) => toHtml(msg.markdown),
+  type: "markdown",
+  render: (content) => ({ html: toHtml(content.source as string) }),
 }
```

`withRender` no longer writes into your message. If you relied on reading
`msg.html` back after `send()`, read the driver's copy instead.

## Drivers

`defineDriver` now makes required options actually required —
`resend()` with no key is a compile error rather than a runtime throw.

Inside a driver, `msg` arrives normalized:

```diff
-const from = normalizeAddresses(msg.from)[0]
-if (!from) throw createError(DRIVER, "INVALID_OPTIONS", "`from` is required")
-const to = normalizeAddresses(msg.to).map(formatAddress)
+const from = formatAddress(msg.from)          // guaranteed present
+const to = msg.to.map(formatAddress)          // never undefined, never empty
```

Other renames: `driver.flags` → `driver.features`; `SendStatusState` →
`SendState`; `driver.sendBatch` returns `Result<EmailResult>[]` (one per
input, in order) instead of `Result<EmailResult[]>`; `EmailError` lives in
`unemail` rather than in the types module.

## Tooling

The repo builds with Bun. There is no `pnpm-lock.yaml` and no
`packageManager` field; `bun install` and `bun run check`. This affects
contributors, not consumers — the published package is unchanged in how it
is installed.
