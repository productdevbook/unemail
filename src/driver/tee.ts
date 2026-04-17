import type { DriverFactory, EmailDriver } from "../types.ts"
import { defineDriver } from "../_define.ts"
import { createError } from "../errors.ts"

/** Fan-out meta driver: every send goes to **all** listed drivers.
 *
 *  The first driver is authoritative — its result is returned and any
 *  failure propagates. The rest are "mirror" drivers used for
 *  auditing/archival; their failures are swallowed (reported via
 *  \`onMirrorError\`) so they never cause the user-facing send to fail.
 *
 *  ```ts
 *  createEmail({ driver: tee({ drivers: [resendPrimary, sesArchive] }) })
 *  ```
 */
export interface TeeOptions {
  drivers: ReadonlyArray<EmailDriver>
  /** Called whenever a non-primary (mirror) driver errors — typical use
   *  is logging to Sentry/OTel. */
  onMirrorError?: (driverName: string, error: Error) => void
  /** Await mirror sends before resolving. Default: false — mirrors run
   *  fire-and-forget so the user doesn't wait on their tail latency. */
  awaitMirrors?: boolean
}

const tee: DriverFactory<TeeOptions> = defineDriver<TeeOptions>((options) => {
  if (!options || options.drivers.length === 0)
    throw createError("tee", "INVALID_OPTIONS", "at least one driver is required")

  const [primary, ...mirrors] = options.drivers
  return {
    name: "tee",
    options,
    async send(msg, ctx) {
      const result = await primary!.send(msg, ctx)

      const fanOut = async (): Promise<void> => {
        await Promise.all(
          mirrors.map(async (driver) => {
            try {
              const r = await driver.send(msg, { ...ctx, driver: driver.name })
              if (r.error) options.onMirrorError?.(driver.name, r.error)
            } catch (err) {
              options.onMirrorError?.(
                driver.name,
                err instanceof Error ? err : new Error(String(err)),
              )
            }
          }),
        )
      }

      if (options.awaitMirrors) await fanOut()
      else void fanOut()

      return result
    },
    async initialize() {
      await Promise.all(options.drivers.map((d) => d.initialize?.()))
    },
    async dispose() {
      await Promise.all(options.drivers.map((d) => d.dispose?.()))
    },
  }
})

export default tee
