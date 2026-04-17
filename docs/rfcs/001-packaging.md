# RFC-001: Package Structure

**Status:** Decision landed for v1.x. Revisit for v2.

## Context

Upyo (our direct peer) ships each transport as its own package
(`@upyo/resend`, `@upyo/sendgrid`, `@upyo/smtp`). `unemail` currently
ships one package with ~50 sub-path exports (e.g.
`unemail/drivers/resend`, `unemail/render/mjml`, `unemail/queue/sqs`).

Both models work. The question is which one minimizes:

1. Install footprint — only paying for what you use.
2. Peer-dep footprint — `mjml`, `@react-email/render`, `juice`,
   `handlebars`, `liquidjs`, `postal-mime` are all optional.
3. Discoverability — one import path vs 50 packages.
4. Maintenance cost — one CHANGELOG + one versioning dance vs 15+
   independent package versions.

## Options

### A. Keep the monorepo single-package model (status quo)

- **Pros:** One `npm install unemail`. One CHANGELOG. Sub-path
  imports already tree-shake well with obuild/ESM. Peer deps are
  truly peer (not installed unless imported).
- **Cons:** Users must know the sub-path exists. `npm ls` looks
  heavy even if you're only using `unemail/drivers/mock`.

### B. Split into ~15 packages under `@unemail/*`

- **Pros:** Tree-shaking becomes obvious at the install level. Users
  discover transports by browsing the `@unemail` scope on npm.
- **Cons:** 15× release coordination. Cross-package refactors need
  matching version bumps. Contributors have a steeper learning
  curve.

### C. Hybrid — `unemail` stays the single install, but we publish

`@unemail/smtp`, `@unemail/resend`, `@unemail/ses` as thin re-exports
for users who want the narrow install.

- **Pros:** Zero behaviour change for existing users. New users can
  opt into narrow installs.
- **Cons:** More publishing steps. Confusing if two import paths
  reach the same code.

## Decision for v1.x

**Stay on Option A.** Reasons:

1. Install size is already competitive (~240 kB dist total, ~5–30 kB
   per sub-path).
2. Every transport we ship uses `fetch` and has no runtime deps, so
   "install `unemail` and pay for Resend-only code" is already the
   reality — tree-shaking does the rest.
3. Peer deps (`mjml`, `@react-email/render`, `juice`, `handlebars`,
   `liquidjs`, `postal-mime`, `@opentelemetry/api`, `unstorage`,
   `bullmq`, `pg-boss`, `@aws-sdk/client-sqs`) are all optional and
   lazy-imported. Users who don't import the relevant sub-path never
   see them in `node_modules`.
4. One version + one CHANGELOG keeps maintenance tractable for a
   solo / small-team OSS project.

## Revisit for v2 if

- Users file more than 5 issues asking for narrow installs.
- Bundle-size budgets push us past 300 kB total dist.
- We add a transport with a large required runtime dep (unlikely —
  every new driver should stick to `fetch`).

## Implementation notes (status quo)

- Every driver is a sub-path export: `unemail/drivers/<name>`.
- Render adapters live under `unemail/render/<name>`.
- Observability + deliverability utilities are lightly grouped:
  `unemail/events`, `unemail/dmarc`, `unemail/mta-sts`,
  `unemail/verify/arc`, `unemail/parse/arf`, `unemail/ics`,
  `unemail/compliance`, `unemail/suppression`, `unemail/preferences`,
  `unemail/address`, `unemail/result`.
- Package entries are listed in `package.json#exports` and mirrored
  in `jsr.json#exports`.
