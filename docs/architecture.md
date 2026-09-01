# Architecture

Three moving parts. Everything else in the repo is one of them.

```
send(msg) ─┐
           ├─▶ normalizeMessage ─▶ compose(middleware) ─▶ driverHandler ─▶ provider
sendBatch ─┘        (once)            (a list)             (a transport)
```

## The unit of work is a list

```ts
type SendHandler = (
  msgs: readonly NormalizedMessage[],
  ctx: SendContext,
) => Promise<readonly Result<EmailResult>[]>

interface Middleware {
  name: string
  handle: (next: SendHandler) => SendHandler
}
```

`send()` is `sendBatch()` with one element. Making the list the primitive
rather than a special case is what buys the property that matters: retry
re-sends only the failed indices, even when the driver reached the provider
in a single request.

```ts
defineMiddleware("retry", (next) => async (msgs, ctx) => {
  const results = [...(await next(msgs, ctx))]
  const pending = results.flatMap((r, i) => (r.error?.retryable ? [i] : []))
  const redo = await next(
    pending.map((i) => msgs[i]!),
    { ...ctx, attempt: 2 },
  )
  for (const [slot, i] of pending.entries()) results[i] = redo[slot]!
  return results
})
```

With a single-message handler this is not expressible: once the driver has
batched, there is no way to reach back and re-send three of five.

The cost is that a middleware that does not care about the batch still has
to map over it. `perMessage()` lifts a per-message function for that case.

## Normalize once, at the edge

`normalizeMessage()` runs exactly once per message, in `createEmail`. It
parses addresses, validates them, guarantees the list fields are present,
rejects a header value containing a line break, derives `List-Unsubscribe`,
injects the preheader, and freezes the result.

That is why no driver in this repo calls an address parser, and why a
message object you pass to `send()` is byte-identical afterwards.

Middleware that changes a message returns a new one. `patchMessage()` is
the supported way:

```ts
return next(
  msgs.map((m) => patchMessage(m, { html })),
  ctx,
)
```

## Results, not exceptions

`send()` and `sendBatch()` do not throw. A normalization failure, a driver
that throws, a middleware with a bug, a driver that returns the wrong
number of results — each becomes a `Result` in the slot it belongs to.

`sendBatch` is positional by contract: `results[i]` corresponds to
`messages[i]`, always. A driver whose `sendBatch` breaks that mapping fails
its whole batch loudly, because every downstream index would otherwise be
silently wrong.

## Middleware state is per destination

`use()` registers a middleware once, and it wraps every mounted driver. So
any state it keeps has to be partitioned by destination — `ctx.driver` plus
`ctx.stream` — or one provider's outage becomes every provider's, which is
the opposite of what mounting a second provider is for.

`src/middleware/_scope.ts` is the shared keying helper. The circuit breaker
and the rate limiter both use it; anything stateful you write should too.

## Drivers are transports

A driver takes a normalized message and gets it to a provider. It does not
retry, rate limit, or log — those are middleware, and they work the same
for every driver.

`fallback` and `roundRobin` are drivers too, not a separate concept: they
take messages and produce results, and they compose with middleware in
either direction.

```ts
fallback([wrap(resend(...), withRetry()), ses(...)])   // retry inside each leg
createEmail({ driver: fallback([...]), use: [withRetry()] })  // retry around the whole thing
```

## Initialization

Per driver, at most once, and the promise is stored before it is awaited —
so two concurrent sends share one initialization instead of racing past a
half-open connection. Keyed by driver rather than by instance, so a driver
mounted after the first send is still initialized.

## What lives where

| Path              | Contains                                                   | Imports Node? |
| ----------------- | ---------------------------------------------------------- | ------------- |
| `src/core/`       | types, errors, results, addresses, normalization, pipeline | no            |
| `src/drivers/`    | transports, one shared `fetch` layer, the MIME builder     | `smtp` only   |
| `src/middleware/` | retry, rate limit, circuit breaker, logger, idempotency    | no            |
| `src/render/`     | the render middleware and the React adapter                | no            |

`src/core/types.ts` compiles to nothing — it is types only, so importing it
costs no bytes in a Worker bundle.

## Invariants CI enforces

- **Bundle budgets** (`scripts/bundle-budget.mjs`) — every entry has a
  ceiling; exceeding one is a deliberate decision, not a drift.
- **Version consistency** (`scripts/check-version.mjs`) — `package.json`,
  `jsr.json` and the `version` constant must agree. They drifted in 0.x.
- **`isolatedDeclarations`** — a file that cannot emit its own `.d.mts`
  fails typecheck rather than shipping a package with missing types.
- **ATTW** — the published `exports` map is checked against an ESM-only
  profile on every pull request.
- **JSR dry run** — a slow type fails the pull request that introduced it,
  rather than halfway through a release with npm already published.
- **Coverage floors** — set at what the suite measured the day they were
  added, so they can only be raised.
