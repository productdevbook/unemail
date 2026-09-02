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

## SendGrid — `unemail/drivers/sendgrid`

```ts
sendgrid({ apiKey, endpoint?, fetch?, timeoutMs?, onBehalfOf?, ipPoolName?,
           asm?, sandbox?, batchIdForScheduled? })
```

Batching is SendGrid's `personalizations`: messages sharing an envelope go
in one request. A run is split when it reaches 1000 personalizations, when
to+cc+bcc across it would pass 1000 recipients, or when an address would
**repeat within one request** — SendGrid rejects that outright, and two
mails to the same person is an easy way to hit it.

The id lives only in the `X-Message-Id` response header, on a 202 with an
empty body.

Scheduling is made cancellable: `send_at` alone cannot be cancelled, so a
scheduled send reserves a `batch_id` and reports that as the result id, which
`cancel()` then acts on. Opt out with `batchIdForScheduled: false`.

A template id starting with `d-` takes the dynamic path
(`dynamic_template_data`); anything else is a legacy template and its
variables are stringified into `substitutions`. There are no template
aliases at SendGrid, so `template.alias` is refused rather than ignored.

Enforced before the wire: ≤10 categories of ≤255 characters (duplicates
deduped), reserved headers refused by name, `scheduledAt` within 72 hours.
The EU host is `https://api.eu.sendgrid.com`, via `endpoint`.

## Mailgun — `unemail/drivers/mailgun`

```ts
mailgun({ apiKey, domain, region?, endpoint?, fetch?, timeoutMs?, sandbox?, ipPool? })
```

`region: "eu"` switches to `api.eu.mailgun.net`.

The Messages API is multipart, not JSON — it takes files — so this driver
hands the shared HTTP layer a `FormData` verbatim.

Messages that differ only in recipient are merged into one request with
`recipient-variables`; without it Mailgun sends one message addressed to
everybody and each recipient sees the whole `To` list. A message with cc,
bcc, several recipients or an attachment is sent alone, because batch
sending fans out on `to` only and merging those would change who receives
what. Chunked at 1000 recipients.

Tags: ≤3, ≤128 characters. The response id has its angle brackets stripped,
because the events API will not accept them back.

`cancel()` and `retrieve()` are not declared. Mailgun's only cancel drops
the whole domain queue, and retrieval needs a storage key from an event
rather than the send id.

## Brevo — `unemail/drivers/brevo`

```ts
brevo({ apiKey, endpoint?, fetch?, timeoutMs?, batchId? })
```

Batches go out as `messageVersions`, split twice: at 1000 versions and at
2000 recipients across them, so 25 messages of 99 recipients become 20 + 5.
A version can only override to/cc/bcc/replyTo/subject/body/params — sender,
attachments, headers, tags, template and schedule belong to the request — so
a batch disagreeing on any of those falls back to one request per message
rather than quietly applying the first message's attachment to everyone.

Brevo's idempotency header is `idempotencyKey`, and it accepts only a UUID.
A UUID-shaped key passes through; anything else is hashed into a v4-shaped
one, stable for the same key. Without that the feature is unusable from
here, since this library's own convention is `welcome:1`.

Sandbox is the `X-Sib-Sandbox: drop` header rather than a separate endpoint.
Metadata and tag values ride in `X-Mailin-custom`, the header Brevo echoes to
webhooks — `tags` itself is a bare string array, so values would otherwise
vanish.

`cancel()` and `retrieve()` are supported.

## MailerSend — `unemail/drivers/mailersend`

```ts
mailersend({ apiKey, endpoint?, fetch?, timeoutMs?, precedenceBulk? })
```

The id arrives only in the `x-message-id` header, on a 202 with no body.

Enforced before the request: `to` ≤50, `cc` ≤10, `bcc` ≤10, ≤5 tags,
`scheduledAt` within 72 hours, bulk chunked at 500. `In-Reply-To`,
`References` and `List-Unsubscribe` are lifted out of `headers` into
MailerSend's dedicated fields.

`retrieve()` falls back from `/v1/messages/{id}` to `/v1/bulk-email/{id}` on
a 404, so the id `sendBatch` hands back is actually resolvable.

The bulk endpoint caps at 5 rather than 500 on trial plans, and the driver
cannot tell which plan a key belongs to.

## Loops — `unemail/drivers/loops`

```ts
loops({ apiKey, transactionalId?, addToAudience?, endpoint?, fetch?, timeoutMs? })
```

Loops has no free-form body: a send is a stored `transactionalId` plus
`dataVariables`. So `features` declares `html: false, text: false`, and a
message carrying `text` or `html` is refused with `UNSUPPORTED` pointing at
`template.variables` — the 0.5 driver sent it as an empty template, and the
recipient got nothing while the call reported success.

Also refused, before the request: no transactional id, more than one
recipient, any cc/bcc/replyTo, an idempotency key over 100 characters.

`dataVariables` merges metadata, then tag name/value pairs, then
`template.variables`. Loops' own template can reference those in its From,
Reply-To, Cc, Bcc and Subject, which is the only per-send way to set them.

## ZeptoMail — `unemail/drivers/zeptomail`

```ts
zeptomail({ token, endpoint?, bounceAddress?, clientReference?,
            trackClicks?, trackOpens?, fetch?, timeoutMs? })
```

The `Zoho-enczapikey ` prefix is added for you, and tolerated if you already
pasted it in.

Its batch endpoint is one message fanned to many recipients with per-
recipient `merge_info`, not N distinct messages — so messages are grouped by
everything the batch cannot vary, and a message with cc or bcc stays off the
batch path entirely, because the fan-out would copy those recipients once
per `to` entry.

Chunking counts **addresses, not messages**: the documented cap of 500 is
addresses, so 300 two-recipient messages split 500 + 100. A message-count
splitter would sail past it.

Error classification reads `error.details[].code`, which says far more than
the status. Note that `LE_101`/`LE_102` — credits exhausted — are mapped
non-retryable rather than `RATE_LIMIT`: waiting does not bring credits back.

Enforced before the request: ≤500 addresses per field, ≤60 attachments,
subject ≤500 characters.

No regional hosts are hard-coded. Zoho's documentation names exactly one API
host; the `.eu`/`.in` pattern appears only in unofficial SDKs, and guessing
one would mean POSTing a live key at a host that may not exist. Use
`endpoint` if yours differs.

## MailChannels — `unemail/drivers/mailchannels`

```ts
mailchannels({ apiKey, endpoint?, async?, dkim?, campaignId?, envelopeFrom?,
               transactional?, trackingDomain?, unsubscribeDomain?,
               fetch?, timeoutMs? })
```

**`apiKey` is required.** The free unauthenticated Cloudflare Workers
integration was terminated on 30 June 2024; MailChannels is a paid product
and an unauthenticated request is rejected. A bad or wrongly-scoped key
answers **403**, not 401.

Its one-request batch is the standout: messages are grouped by shared body,
each becomes a personalization, chunked at 1000. Outcomes are read by each
result's own `index` rather than by position, and a personalization with no
outcome fails loudly instead of borrowing its neighbour's id.

DKIM is per personalization and may be a function of the message, so
multi-tenant sending works _inside_ one batch request:

```ts
mailchannels({ apiKey, dkim: (msg) => keyFor(msg.from.email.split("@")[1]!) })
```

`message.sandbox` maps to the dry-run mode, which returns the rendered
document instead of sending it. Templates are inline Mustache only — there
is no stored-template system, so `template.id`/`alias` is refused with a
reason and `template.variables` drives the Mustache path.

## Mailcrab — `unemail/drivers/mailcrab`

```ts
mailcrab({ host?, port?, httpPort?, httpEndpoint?, prefix?, secure?, ... })
```

A local catcher for development: correct SMTP defaults (`localhost:1025`,
plain, no auth) plus an inbox you can read back.

```sh
docker run --rm -p 1080:1080 -p 1025:1025 marlonb/mailcrab
```

`getInstance()` returns the inbox over Mailcrab's HTTP API on 1080 — `list`,
`get`, `find`, `last`, `byMessageId`, `delete`, `clear`, `version` — every
method returning a `Result` and none throwing. `retrieve(id)` takes either
Mailcrab's UUID or the `Message-ID` that `send()` returned.

Mailcrab parses only `From` and `To`, so `find()` also matches the envelope
recipients — the only place a cc address appears. `MAILCRAB_PREFIX` nests
every route, which is what `prefix` moves.

`ENABLE_TLS_AUTH` gives implicit TLS with a self-signed certificate, so
`secure` maps to implicit TLS with verification off. That is correct for a
local catcher and wrong anywhere else.

## HTTP — `unemail/drivers/http`

```ts
http({ endpoint, method?, auth?, headers?, body?, extractId?, classify?,
       features?, name?, fetch?, timeoutMs? })
```

For an API this library has no driver for: an internal gateway, a
self-hosted relay, a webhook-shaped endpoint. Ten lines and an unsupported
provider gets retry, rate limiting and the circuit breaker working properly:

```ts
http({
  endpoint: "https://mail.internal/send",
  auth: { type: "bearer", token: process.env.GATEWAY_TOKEN! },
  body: (msg) => ({ to: msg.to.map((a) => a.email), subject: msg.subject, html: msg.html }),
  extractId: (body) => (body as { id: string }).id,
  classify: (status) => (status === 409 ? { code: "RATE_LIMIT", retryable: true } : null),
})
```

`classify` is the one worth using: without it every non-2xx is judged by
status alone, so a gateway that signals throttling with a 409 looks
permanent and retry gives up.

No `sendBatch`. An unknown endpoint gives no way to know which of N messages
an answer refers to, and a wrong mapping is worse than N requests — the core
then sends sequentially and positionality is exact by construction.

`features` is unset by default, because the driver cannot know what an
arbitrary gateway supports. Declare it and the core's early refusal starts
working for you.

## Tee — `unemail/drivers/tee`

```ts
tee([primary, ...mirrors], { onSecondaryError?, name? })
```

Sends the same message through several drivers at once — shadowing a new
provider against the incumbent, or mirroring production mail into a local
catcher.

```ts
tee([resend({ apiKey }), mailcrab()])
```

The first driver is the primary and its result is the send's result. **A
mirror failing never fails the send** — that is the whole difference from
`fallback`. But it is not swallowed either: failures are appended to
`ctx.meta.tee`, which the core copies onto both `EmailResult.meta` and
`EmailError.meta`, and handed to `onSecondaryError`. A tee whose mirror
failures are invisible is useless for the thing it exists to do.

Legs run concurrently and all are awaited. Concurrently because a shadow only
measures anything under the same conditions as the primary; awaited because a
dropped promise never finishes on a runtime that freezes the isolate at the
response, and because the meta snapshot is taken the moment the pipeline
returns. The cost is that a send takes the slowest leg's time — bound it with
that leg's own `timeoutMs`.

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

Read it at runtime rather than hard-coding it:

```ts
if (email.driver.features?.scheduling) await email.send({ ...msg, scheduledAt })
```

The core reads it too. A message asking for something the driver has said it
cannot do — a `template` on a driver without templates, a `scheduledAt` on
one without scheduling — comes back `UNSUPPORTED` rather than being sent
without the part that mattered. Only that message fails; the rest of a batch
goes out. A driver that declares no `features` at all is not second-guessed.

|                          |     batch      | scheduling | templates | tracking | tagging | sandbox | idempotency | cancel | retrieve | Worker |
| ------------------------ | :------------: | :--------: | :-------: | :------: | :-----: | :-----: | :---------: | :----: | :------: | :----: |
| resend                   |       ✅       |     ✅     |     —     |    —     |   ✅    |    —    |     ✅      |   ✅   |    ✅    |   ✅   |
| postmark                 |       ✅       |     —      |    ✅     |    ✅    |   ✅    |    —    |      —      |   —    |    —     |   ✅   |
| ses                      |       —        |     —      |     —     |    —     |   ✅    |    —    |      —      |   —    |    —     |   ✅   |
| smtp                     |       —        |     —      |     —     |    —     |    —    |    —    |      —      |   —    |    —     |   —    |
| sendgrid                 |       ✅       |     ✅     |    ✅     |    ✅    |   ✅    |   ✅    |      —      |   ✅   |    ✅    |   ✅   |
| mailgun                  |       ✅       |     ✅     |    ✅     |    ✅    |   ✅    |   ✅    |      —      |   —    |    —     |   ✅   |
| brevo                    |       ✅       |     ✅     |    ✅     |    —     |   ✅    |   ✅    |     ✅      |   ✅   |    ✅    |   ✅   |
| mailersend               |       ✅       |     ✅     |    ✅     |    ✅    |   ✅    |    —    |      —      |   ✅   |    ✅    |   ✅   |
| mailtrap                 |       ✅       |     —      |    ✅     |    —     |   ✅    |   ✅    |      —      |   —    |    —     |   ✅   |
| zeptomail                |       ✅       |     —      |    ✅     |    ✅    |    —    |    —    |      —      |   —    |    —     |   ✅   |
| mailchannels             |       ✅       |     —      |    ✅     |    ✅    |   ✅    |   ✅    |      —      |   —    |    —     |   ✅   |
| loops                    |       —        |     —      |    ✅     |    —     |    —    |    —    |     ✅      |   —    |    —     |   ✅   |
| cloudflare-email         |       —        |     —      |     —     |    —     |    —    |    —    |      —      |   —    |    —     |   ✅   |
| cloudflare-email-service |       —        |     —      |     —     |    —     |    —    |    —    |      —      |   —    |    —     |   ✅   |
| cloudflare-email-rest    |       —        |     —      |     —     |    —     |    —    |    —    |      —      |   —    |    —     |   ✅   |
| mailcrab                 |       —        |     —      |     —     |    —     |    —    |    —    |      —      |   —    |    ✅    |   —    |
| http                     | you declare it |            |           |          |         |         |             |        |          |   ✅   |
| mock                     |       ✅       |     ✅     |    ✅     |    ✅    |   ✅    |   ✅    |     ✅      |   —    |    —     |   ✅   |

Every driver supports attachments, html, text, reply-to and custom headers,
except where the provider genuinely has no such field — `loops` has no
free-form body at all, and `mailchannels` has no stored templates.

"Worker" means it needs nothing beyond `fetch` and Web Crypto. `smtp` and
`mailcrab` need `node:net` and `node:tls`.
