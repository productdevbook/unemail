# Benchmarks

```sh
bun run bench                     # everything
bun run bench bench/mime.bench.ts # one file
```

`vitest bench` under the hood, so no dependency beyond what the test suite
already pulls in.

## What is measured here, and what is not

Timing answers "how much does the library cost on top of the provider". It
does not answer the question the architecture is actually built around —
how many messages reach the provider — because that is a count, and counting
it is exact where timing it is not.

So the split is deliberate:

- **`bench/`** measures what is genuinely time-bound: normalization, the
  middleware pipeline, MIME assembly, DKIM, base64.
- **`test/middleware/batch-cost.test.ts`** _asserts_ the delivery counts.
  A benchmark there would have been misleading: against an in-process
  driver, re-sending 5 messages versus 500 is lost under the fixed cost of
  normalizing the batch once, and the run reports about 1.05x. The real
  difference is provider quota and duplicate deliveries, and neither is
  visible to a stopwatch.

Numbers below are from an AMD Ryzen 5 3600, Node 24.15, Linux. They are
indicative — read the ratios, not the absolutes, and re-run on your own
hardware before quoting any of it.

## Cost per message

|                                                                       | ops/sec | per message |
| --------------------------------------------------------------------- | ------: | ----------: |
| `normalizeMessage` — minimal                                          |    643k |      1.6 µs |
| `normalizeMessage` — typical (preheader, unsubscribe, tags, metadata) |    232k |      4.3 µs |
| `normalizeMessage` — 60 recipients                                    |     40k |       25 µs |
| `send` through the mock driver, no middleware                         |   44.5k |       22 µs |
| `sendBatch` of 1000                                                   |  58/sec |       17 µs |

Normalization is not the cost centre; the pipeline around it is. A batch of
1000 costs about the same per message as a batch of 10, so batching buys
provider round trips rather than CPU.

## What middleware costs

|                                                     | ops/sec |        overhead |
| --------------------------------------------------- | ------: | --------------: |
| no middleware                                       |   44.5k |               — |
| 1 middleware                                        |   46.4k | none measurable |
| 5 middleware                                        |   47.1k | none measurable |
| logger + breaker + retry + rate limit + idempotency |   34.7k |      ~6 µs/send |

Composition itself is free — five no-op wrappers are inside the noise. The
~22% for the real stack is the middleware's own work (a token bucket, a
map lookup, a store round trip), not the wrapping.

## `sendStream` chunk size

| chunkSize    | 1000 messages |
| ------------ | ------------: |
| 1            |       17.6 ms |
| 50 (default) |       13.8 ms |
| 500          |       15.2 ms |

The default is where it is because a chunk of 1 pays the per-trip cost a
thousand times, and a large chunk gives the memory back that streaming was
for.

## MIME assembly

|                                    | ops/sec |
| ---------------------------------- | ------: |
| text only                          |    220k |
| multipart/alternative              |     27k |
| non-ASCII body and subject         |    6.8k |
| multipart/mixed, 256 KB attachment |     863 |

Quoted-printable is the cost: it walks the body a character at a time, so a
non-ASCII message is ~32× a plain ASCII one. That is the slowest thing in
the library that runs per message, and the first place to look if SMTP
throughput ever matters.

## DKIM

|                  | ops/sec |
| ---------------- | ------: |
| `ed25519-sha256` |    6.2k |
| `rsa-sha256`     |    1.3k |

**Ed25519 signs 4.8× faster**, and its signature is a fraction of the size.
That is the whole argument for RFC 8463, and the reason both are supported
rather than only the one everybody already has a key for.

## Base64

|        | ops/sec |
| ------ | ------: |
| 16 KB  |    181k |
| 256 KB |    4.1k |
| 4 MB   |     577 |

Linear in size, as it should be — the chunked fallback exists so a large
attachment does not blow the argument limit, not because it is faster.

## Delivery cost — counted, not timed

From `test/middleware/batch-cost.test.ts`, on a 500-message batch:

| failure rate   | messages delivered to the provider | requests |
| -------------- | ---------------------------------: | -------: |
| none           |                                500 |        1 |
| 1% (5 fail)    |                                505 |        2 |
| 5% (25 fail)   |                                525 |        2 |
| 20% (100 fail) |                                600 |        2 |

Re-sending the whole batch — what a retry wrapped around an all-or-nothing
`sendBatch` has to do — would be 1000 in every failing row, and on a
provider without idempotency that is 500 people receiving the message twice.

Failover behaves the same way: with 5% failing at the primary, the standby
sees 25 messages, not 500.
