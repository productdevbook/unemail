# Typed `getInstance()` — native provider SDK escape hatch

`unemail` wraps what's portable across drivers, but sometimes you need
a provider-native API that nobody else has (Resend audiences, SES
templates, SendGrid IP warmup). The `EmailDriver.getInstance()` hook
is a typed escape hatch.

## Usage

```ts
import { defineDriver } from "unemail"
import { Resend } from "resend"

export function resendWithInstance(opts: { apiKey: string }) {
  const client = new Resend(opts.apiKey)
  return defineDriver<typeof opts, Resend>(() => ({
    name: "resend-native",
    getInstance: () => client,
    async send(msg) {
      const { data, error } = await client.emails.send({
        from: String(msg.from),
        to: String(msg.to),
        subject: msg.subject,
        text: msg.text ?? "",
      })
      if (error) return { data: null, error: new Error(error.message) as never }
      return { data: { id: data!.id, driver: "resend-native", at: new Date() }, error: null }
    },
  }))(opts)
}

// Consumer code:
const driver = resendWithInstance({ apiKey: "re_..." })
const email = createEmail({ driver })

// Typed access to the native SDK for things unemail doesn't wrap:
const resend = driver.getInstance?.()
if (resend) {
  await resend.audiences.create({ name: "allhands" })
}
```

## When to reach for it

- **Native audiences / broadcasts / contacts** — e.g. Resend's
  `audiences`, SendGrid's `contactdb`.
- **Suppression / template CRUD** — SES `CreateTemplate`, Mailgun
  routes.
- **Advanced auth flows** — IdP-signed requests outside the scope of
  `unemail/middleware/oauth2`.

When the feature is portable across 2+ providers it belongs in core
(file an issue). When it's a single-provider escape hatch,
`getInstance()` is the right answer.
