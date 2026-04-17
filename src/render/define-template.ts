import type { EmailMessage } from "../types.ts"

/** A compiled template — a function that takes typed variables and
 *  returns a partial `EmailMessage` ready to splat into `email.send()`. */
export type TemplateFn<Vars, Output extends Partial<EmailMessage>> = (vars: Vars) => Output

/** Declare a template with compile-time-checked variables.
 *
 *  ```ts
 *  const welcome = defineTemplate<{ name: string }>(({ name }) => ({
 *    subject: `Welcome, ${name}!`,
 *    react: <Welcome name={name} />,
 *  }))
 *
 *  await email.send({ from, to, ...welcome({ name: "Ada" }) })
 *  ```
 *
 *  Pass `render` as a function that produces whichever shape you want
 *  (`{ react }`, `{ jsx }`, `{ mjml }`, or direct `{ html }`) — all of
 *  them land as a typed `Partial<EmailMessage>`.
 */
export function defineTemplate<Vars = void>(
  render: (vars: Vars) => Partial<EmailMessage>,
): TemplateFn<Vars, Partial<EmailMessage>> {
  return render
}
