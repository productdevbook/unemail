# Observability

Two middlewares give you production-grade visibility without extra deps.

## Structured logging

```ts
import { withLogger } from "unemail"

email.use(withLogger())
// → `console.info(JSON.stringify(entry))` on each send.start / send.success
// → `console.error(JSON.stringify(entry))` on send.error
```

Pipe the output somewhere (Pino, Axiom, Logflare, Datadog) via a custom
sink:

```ts
email.use(
  withLogger({
    sink: (entry) => logger.info(entry),
    redactLocalPart: true, // ada@acme.com → a***@acme.com
    includeSubject: false, // subjects can contain PII; turn off if needed
  }),
)
```

Entries include `driver`, `stream`, `attempt`, `messageId`, `recipient`,
`subject`, `durationMs`, `error.{code,message,retryable}`, and any
`ctx.meta` fields set by other middleware.

## OpenTelemetry tracing

```ts
import { trace } from "@opentelemetry/api"
import { withTelemetry } from "unemail"

email.use(withTelemetry({ tracer: trace.getTracer("unemail") }))
```

Each send produces one span (`email.send`) with attributes:

- `email.driver`, `email.stream`, `email.attempt`
- `email.to`, `email.subject.length`
- `email.message_id` (on success)
- `email.error.code` (on failure)

When no tracer is passed, `withTelemetry()` is a no-op — cheap to leave
in place for environments that don't have OTel wired up.

## Sampling

```ts
email.use(
  withTelemetry({
    tracer,
    sample: (attrs) => attrs["email.stream"] !== "health-check",
  }),
)
```

Return `false` to skip span creation for a given send.
