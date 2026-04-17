# Testing

`unemail/test` ships an `Email` instance backed by the mock driver so
you never have to stub providers by hand.

## The test inbox

```ts
import { createTestEmail } from "unemail/test"
import { it, expect } from "vitest"

it("sends a welcome email", async () => {
  const email = createTestEmail()
  await signUpUser(email, { email: "ada@acme.com", name: "Ada" })

  expect(email.inbox).toHaveLength(1)
  expect(email.last?.subject).toMatch(/welcome/i)
  expect(email.find((m) => m.to === "ada@acme.com")).toBeDefined()
})
```

## Waiting for async sends

When the send happens on a timer or a background task:

```ts
const msg = await email.waitFor((m) => m.subject === "Reminder", {
  timeout: 2000,
  interval: 20,
})
expect(msg.text).toContain("you left something in the cart")
```

## Vitest matchers

```ts
import { expect } from "vitest"
import { createTestEmail, emailMatchers } from "unemail/test"

expect.extend(emailMatchers)

declare module "vitest" {
  interface Matchers<R = unknown> {
    toHaveSent: (match: {
      from?: string | RegExp
      to?: string | RegExp
      subject?: string | RegExp
      html?: string | RegExp
      text?: string | RegExp
      stream?: string
    }) => R
  }
}

const email = createTestEmail()
// …send something…
expect(email).toHaveSent({ to: "ada@acme.com", subject: /welcome/i })
```

If you can't use the `expect.extend` augmentation, call
`matchesEmail(message, match)` directly — it returns
`{ pass, diff }`.

## Integration tests with MailCrab

When you need a real SMTP server to exercise the full pipeline:

```ts
import { createEmail } from "unemail"
import mailcrab from "unemail/drivers/mailcrab"

const email = createEmail({ driver: mailcrab({ quiet: true }) })
await email.send({ from, to, subject, text })
// Open http://localhost:1080 to inspect
```

Run `pnpm dlx unemail-mailcrab` to spin up the server via Docker.
