# Rendering

unemail doesn't have an opinion on templates — you render with whatever
you already use, and the `withRender` middleware drops the result into
`msg.html` before the driver sees it.

## React Email

```ts
import { createEmail, withRender } from "unemail"
import resend from "unemail/drivers/resend"
import reactRender from "unemail/render/react"
import { Welcome } from "./emails/welcome.tsx"

const email = createEmail({ driver: resend({ apiKey: process.env.RESEND_KEY! }) })
email.use(withRender(reactRender()))

await email.send({
  from: "Acme <hi@acme.com>",
  to: "user@example.com",
  subject: "Welcome",
  react: <Welcome name="Ada" />,
})
```

The `@react-email/render` peer is loaded lazily — the module parses on
Cloudflare Workers even without it installed.

## jsx-email

```ts
import jsxRender from "unemail/render/jsx-email"

email.use(withRender(jsxRender({ inlineCss: true })))
await email.send({ from, to, subject, jsx: <Invoice amount={42} /> })
```

Peer: `jsx-email`.

## MJML

```ts
import mjmlRender from "unemail/render/mjml"

email.use(withRender(mjmlRender()))
await email.send({
  from,
  to,
  subject,
  mjml: `<mjml><mj-body><mj-section><mj-column>
    <mj-text>Hello Ada</mj-text>
  </mj-column></mj-section></mj-body></mjml>`,
})
```

Peer: `mjml` (or `mjml-browser` in the browser).

## Combining adapters

`withRender` accepts any number of adapters. The first whose `match(msg)`
returns true wins, so you can register all three safely:

```ts
email.use(withRender(reactRender(), jsxRender(), mjmlRender()))
```

## Plain text fallback

When a renderer resolves `msg.html` and you didn't set `msg.text`, the
middleware derives plain text via `htmlToText` automatically. Disable
with `withRender(...renderers).options.autoText = false` or set
`msg.text` yourself.

## Type-safe templates

```ts
import { defineTemplate } from "unemail"
import { Welcome } from "./emails/welcome.tsx"

export const welcome = defineTemplate<{ name: string, activationUrl: string }>(
  ({ name, activationUrl }) => ({
    subject: `Welcome, ${name}!`,
    react: <Welcome name={name} activationUrl={activationUrl} />,
  }),
)

// Compile-time check on variables:
const rendered = welcome({ name: "Ada", activationUrl: "https://…" })
await email.send({ from, to, subject: rendered.subject!, react: rendered.react })
```
