# Drivers

## Resend — `unemail/drivers/resend`

```ts
resend({ apiKey: process.env.RESEND_API_KEY!, endpoint?, fetch?, timeoutMs? })
```

Native batch (`/emails/batch`), scheduling, `cancel()`, `retrieve()`, and
provider-side idempotency via the `Idempotency-Key` header when the message
carries an `idempotencyKey`. A batch presents one key derived from its
messages' keys — stable for the same batch, so a retry is recognised as a
repeat rather than duplicating every message in it.

Batches are chunked at Resend's cap of 100 messages per request. Resend's
batch endpoint does not accept attachments, so a batch carrying one is sent
message by message instead; the caller sees no difference.

Resend has no metadata field, so `message.metadata` is sent as
`X-Metadata-*` headers — which is what comes back on its webhook events.

The key is checked for its `re_` prefix at construction.

## Postmark — `unemail/drivers/postmark`

```ts
postmark({ token, messageStream?, endpoint?, fetch?, timeoutMs? })
```

Pass the per-server token, not the account token.

Postmark reports per-message failures inside a `200` batch response; those
become individual failed results rather than a failed batch. Batches are
chunked at its cap of 500.

Its `Tag` is a single string with no value, so the first tag's name goes
there and every tag — the first included — is also carried as `Metadata`.

Templated and plain messages use different endpoints and cannot be mixed in
one batch — a mixed batch fails with `INVALID_OPTIONS` before any request
is made.

Route with `message.stream`, which overrides the driver's `messageStream`.

## Amazon SES — `unemail/drivers/ses`

```ts
ses({ region, accessKeyId?, secretAccessKey?, sessionToken?,
      configurationSetName?, fromArn?, endpoint?, fetch? })
```

No `@aws-sdk/*`: SigV4 is signed with Web Crypto and the message is posted
as raw MIME, so attachments and inline images work and the driver runs in a
Worker. Credentials fall back to `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`.

SES reads recipients off the envelope, which is where bcc lives — blind
recipients reach the provider without appearing in the document.

`__type` is read for classification, so an expired token is `AUTH` and
throttling is a retryable `RATE_LIMIT` rather than a generic 400.

SES v2 has no raw-MIME bulk endpoint, so there is no `sendBatch`; the core
sends sequentially.

## SMTP — `unemail/drivers/smtp`

```ts
smtp({
  host, port?, secure?, requireTLS?,
  user?, password?, authMethod?, getAccessToken?,
  rejectUnauthorized?, tls?, localName?,
  pool?, maxConnections?, maxMessagesPerConnection?, idleTimeoutMs?,
  connectionTimeoutMs?, commandTimeoutMs?, disposeGraceMs?,
  dkim?,
})
```

Its own protocol implementation — no `nodemailer`, no transitive
dependencies. `port` defaults to 465 when `secure`, 587 otherwise.
`rejectUnauthorized` defaults to `true`.

`AUTO` picks the strongest method the server advertises (`XOAUTH2`,
`CRAM-MD5`, `PLAIN`, `LOGIN`).

With `pool: true` connections are reused; one that fails mid-transaction is
discarded rather than returned in an unknown protocol state.

`EHLO` announces the machine's hostname when it is fully qualified, and
`localhost.localdomain` otherwise. Override it with `localName`.

DKIM signs the assembled document, and accepts an RSA key in either PKCS8
(`BEGIN PRIVATE KEY`) or PKCS1 (`BEGIN RSA PRIVATE KEY`, what
`openssl genrsa` writes); Ed25519 must be PKCS8. Pass a function to select a
key per message for multi-tenant sending:

```ts
smtp({ host, dkim: (msg) => keyFor(msg.from.email.split("@")[1]!) })
```

`message.raw` bypasses the MIME builder entirely; the envelope is still
taken from the message's addresses.

Needs `node:net` and `node:tls` — this is the one driver that does not run
in a Worker.

Every API driver takes `timeoutMs` (default 30_000) and forwards the
instance's `AbortSignal`, so a cancelled request is cancelled in flight.
Lower it behind a user-facing handler: the retry middleware needs control
back before the caller's own request times out.

## Mailtrap — `unemail/drivers/mailtrap`

```ts
mailtrap({ apiKey, endpoint?, fetch?, timeoutMs?, defaultCategory?, userAgent?,
           sandbox?, inboxId?, sandboxEndpoint?, bulk?, bulkEndpoint? })
```

Three hosts, one driver. The Email API delivers transactional mail; `bulk`
routes to `bulk.api.mailtrap.io`, which Mailtrap keeps separate so a
newsletter cannot damage the reputation carrying your password resets; and
the Email Sandbox captures into an inbox and needs `inboxId` in the request
path. So
`message.sandbox` — or the driver-level `sandbox` — chooses the whole
endpoint rather than setting a field, and a sandbox send with no `inboxId`
is refused before a request is made. This is not the same thing as
SendGrid's or Mailgun's test flags, which stay on the production API.

A batch cannot mix sandbox and live messages; that is refused rather than
half-sent. Batches chunk at Mailtrap's cap of 500 per request, and a
recipient list past its 1000-address limit is refused before the call.

Mailtrap groups by category and rejects a message without one, so a tag
named `category` supplies it and `defaultCategory` (default `general`)
covers the rest. Other tags travel as `custom_variables` alongside
`message.metadata`.

It also reports failures inside a `200` response as `success: false` with an
`errors` array; those become failed results, not silent successes.

## Cloudflare Email Routing — `unemail/drivers/cloudflare-email`

```ts
cloudflareEmail({ binding, EmailMessage? })
```

The `send_email` binding from your `wrangler.toml`. It takes a raw RFC 5322
document, which the shared MIME builder produces — so attachments and inline
images work as they do over SMTP, with no network call of our own.

The legacy `EmailMessage(from, to, raw)` constructor takes a single envelope
recipient, so a message with more than one `to`, or any `cc`/`bcc`, is
refused — sending only to the first would look like a delivery that worked.
For several recipients, or for anything new, use the Email Service driver
below; Cloudflare keeps this API for compatibility only.

`EmailMessage` lives in the `cloudflare:email` virtual module, which this
package cannot import and still run on Node, so pass it in:

```ts
import { EmailMessage } from "cloudflare:email"
cloudflareEmail({ binding: env.SEND_EMAIL, EmailMessage })
```

## Cloudflare Email Service — `unemail/drivers/cloudflare-email-service`

```ts
cloudflareEmailService({ binding })
```

The newer Email Sending API on the same `send_email` binding, taking
structured fields rather than raw MIME — so this driver needs no ambient
global, no virtual module and no MIME builder. Both Cloudflare drivers ship;
pick the one matching the API your binding speaks.

Needs a sender domain onboarded with `wrangler email sending enable
<domain>`.

Limits enforced before the call: 50 recipients across to/cc/bcc, and 32
attachments. The binding also caps a message at 5 MiB, which only it can
measure.

The binding throws errors carrying an `E_*` code, and each is mapped onto
the shared taxonomy — `E_RATE_LIMIT_EXCEEDED` becomes a retryable
`RATE_LIMIT`, `E_SENDER_NOT_VERIFIED` a permanent `AUTH`. Without that,
retry would keep re-sending messages that only a configuration fix cures.

## Cloudflare Email Service over HTTP — `unemail/drivers/cloudflare-email-rest`

```ts
cloudflareEmailRest({ accountId, apiToken, endpoint?, fetch?, timeoutMs? })
```

The same service as the binding above, reached over the REST API with an
account token — so it runs on Node, Deno, Bun or anywhere else with
`fetch`, not only inside a Worker. Inside a Worker, prefer the binding: one
less hop and no token to manage.

Two differences worth knowing. Cloudflare uses numeric error codes here
rather than the binding's `E_*` strings, and they are mapped to the same
taxonomy. And the response reports the outcome **per recipient** rather than
returning a message id, so a send that was permanently bounced for some
addresses and delivered to others is reported as a failure naming them —
calling that a success would hide addresses that will never receive it.

## Mock — `unemail/drivers/mock`

```ts
mock({ fail?, failWhen?, latencyMs?, inbox? })
```

`getInstance()` returns the inbox: `messages`, `find(address)`, `last()`,
`clear()`. Messages are stored normalized, so assertions see what a real
driver would have seen.

## Fallback — `unemail/drivers/fallback`

```ts
fallback(drivers, { shouldFailover?, onFailover?, name? })
```

Per message, not per batch: only the messages a leg failed reach the next
one. `INVALID_OPTIONS` and `UNSUPPORTED` do not fail over — the next
provider would reject them too. Legs initialize lazily as they are reached.

## Round-robin — `unemail/drivers/round-robin`

```ts
roundRobin(drivers, { weights?, name? })
```

Spreads sends to stay under each provider's limit, or to warm a second
sending domain. A batch is partitioned and each partition goes to its
driver in one request, so native batching survives the split. It does not
fail over — put it behind `fallback` if you need that.

## Capability matrix

|                      | Resend | Postmark | SES | SMTP | Mock |
| -------------------- | :----: | :------: | :-: | :--: | :--: |
| attachments          |   ✅   |    ✅    | ✅  |  ✅  |  ✅  |
| html / text          |   ✅   |    ✅    | ✅  |  ✅  |  ✅  |
| native batch         |   ✅   |    ✅    |  —  |  —   |  ✅  |
| scheduling           |   ✅   |    —     |  —  |  —   |  ✅  |
| provider idempotency |   ✅   |    —     |  —  |  —   |  ✅  |
| templates            |   —    |    ✅    |  —  |  —   |  ✅  |
| tracking             |   —    |    ✅    |  —  |  —   |  ✅  |
| tagging              |   ✅   |    ✅    | ✅  |  —   |  ✅  |
| cancel / retrieve    |   ✅   |    —     |  —  |  —   |  —   |

Read it at runtime rather than hard-coding it:

```ts
if (email.driver.features?.scheduling) await email.send({ ...msg, scheduledAt })
```

The core reads it too. A message asking for something the driver has said it
cannot do — a `template` on a driver without templates, a `scheduledAt` on
one without scheduling — comes back `UNSUPPORTED` rather than being sent
without the part that mattered. Only that message fails; the rest of a batch
goes out. A driver that declares no `features` at all is not second-guessed.
