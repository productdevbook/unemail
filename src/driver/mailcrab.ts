import type { DriverFactory } from "../types.ts"
import type { SmtpDriverOptions } from "./smtp.ts"
import { defineDriver } from "../_define.ts"
import smtp from "./smtp.ts"

/** MailCrab is a local SMTP sink (the \`unemail-mailcrab\` CLI spins it up
 *  via docker). This driver is a thin wrapper over the SMTP driver with
 *  MailCrab-friendly defaults so \`createEmail({ driver: mailcrab() })\`
 *  Just Works in dev.
 *
 *  The web UI lives at \`http://localhost:1080\` — a one-liner pointer is
 *  printed on first use so new users find it fast. */
export interface MailCrabDriverOptions extends Partial<SmtpDriverOptions> {
  /** Defaults to \`localhost\`. */
  host?: string
  /** Defaults to \`1025\` (MailCrab's SMTP port). */
  port?: number
  /** Web UI port, used only for the on-first-send help message. Default 1080. */
  uiPort?: number
  /** Silence the "see messages at …" hint. Default \`false\`. */
  quiet?: boolean
}

const mailcrab: DriverFactory<MailCrabDriverOptions> = defineDriver<MailCrabDriverOptions>(
  (options = {}) => {
    const host = options.host ?? "localhost"
    const port = options.port ?? 1025
    const uiPort = options.uiPort ?? 1080
    const delegate = smtp({
      ...options,
      host,
      port,
      secure: false,
      rejectUnauthorized: false,
      commandTimeoutMs: options.commandTimeoutMs ?? 5000,
      connectionTimeoutMs: options.connectionTimeoutMs ?? 5000,
    })
    let hinted = false

    return {
      ...delegate,
      name: "mailcrab",
      async send(msg, ctx) {
        if (!hinted && !options.quiet) {
          hinted = true
          console.info(`[unemail] [mailcrab] inspecting messages at http://${host}:${uiPort}`)
        }
        const result = await delegate.send(msg, ctx)
        if (result.data) return { data: { ...result.data, driver: "mailcrab" }, error: null }
        return result
      },
    }
  },
)

export default mailcrab
