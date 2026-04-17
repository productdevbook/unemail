import type { DriverFactory, EmailDriver } from "../types.ts"
import { defineDriver } from "../_define.ts"
import { createError, toEmailError } from "../errors.ts"

/** Try each wrapped driver in order; move on to the next when the current
 *  one returns a retryable error. Non-retryable errors short-circuit.
 *
 *  ```ts
 *  createEmail({ driver: fallback([resend({...}), ses({...})]) })
 *  ```
 */
export interface FallbackOptions {
  drivers: ReadonlyArray<EmailDriver>
  /** Override the "is this error worth moving on for" check. */
  shouldAdvance?: (error: NonNullable<Awaited<ReturnType<EmailDriver["send"]>>["error"]>) => boolean
}

const fallback: DriverFactory<FallbackOptions> = defineDriver<FallbackOptions>((options) => {
  if (!options || options.drivers.length === 0)
    throw createError("fallback", "INVALID_OPTIONS", "at least one driver is required")
  const drivers = options.drivers
  const shouldAdvance = options.shouldAdvance ?? ((err) => err.retryable)

  return {
    name: "fallback",
    options,
    async send(msg, ctx) {
      let lastError: ReturnType<typeof toEmailError> | null = null
      for (const driver of drivers) {
        ctx.driver = driver.name
        try {
          const result = await driver.send(msg, ctx)
          if (result.data) return result
          lastError = result.error
          if (!shouldAdvance(result.error)) return result
        } catch (thrown) {
          lastError = toEmailError(driver.name, thrown)
        }
      }
      return {
        data: null,
        error: lastError ?? createError("fallback", "PROVIDER", "all drivers failed"),
      }
    },
    async initialize() {
      await Promise.all(drivers.map((d) => d.initialize?.()))
    },
    async dispose() {
      await Promise.all(drivers.map((d) => d.dispose?.()))
    },
    async isAvailable() {
      for (const d of drivers) {
        if (!d.isAvailable) return true
        if (await d.isAvailable()) return true
      }
      return false
    },
  }
})

export default fallback
