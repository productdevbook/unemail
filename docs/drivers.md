# Drivers

## Resend — `unemail/drivers/resend`

```ts
resend({ apiKey: process.env.RESEND_API_KEY!, endpoint?, fetch? })
```

Native batch (`/emails/batch`), scheduling, `cancel()`, `retrieve()`, and
provider-side idempotency via the `Idempotency-Key` header when the message
carries an `idempotencyKey`.

Resend has no metadata field, so `message.metadata` is sent as
`X-Metadata-*` headers — which is what comes back on its webhook events.

The key is checked for its `re_` prefix at construction.

## Postmark — `unemail/drivers/postmark`

```ts
postmark({ token, messageStream?, endpoint?, fetch? })
```

Pass the per-server token, not the account token.

Postmark reports per-message failures inside a `200` batch response; those
become individual failed results rather than a failed batch. It accepts one
`Tag` per message, so extra tags carry as metadata instead of being dropped.

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

DKIM signs the assembled document. Pass a function to select a key per
message for multi-tenant sending:

```ts
smtp({ host, dkim: (msg) => keyFor(msg.from.email.split("@")[1]!) })
```

`message.raw` bypasses the MIME builder entirely; the envelope is still
taken from the message's addresses.

Needs `node:net` and `node:tls` — this is the one driver that does not run
in a Worker.

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
