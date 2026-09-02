import type { EmailDriver } from "../core/types.ts"

/**
 * Initialize each driver at most once.
 *
 * The composites reach their legs directly rather than through the core, so
 * the core's memoized `ensureInitialized` never sees them and every send
 * paid for an `initialize()` again. Same shape as the core's: the promise
 * is stored before it is awaited, so concurrent sends share one
 * initialization instead of racing past a half-open connection.
 *
 * @module
 */
export function createInitializer(): (driver: EmailDriver) => Promise<void> {
  const pending = new Map<EmailDriver, Promise<void>>()
  return (driver) => {
    let started = pending.get(driver)
    if (started) return started
    started = (async () => {
      try {
        await driver.initialize?.()
      } catch (error) {
        // A failed initialization is not remembered, so the next send retries.
        pending.delete(driver)
        throw error
      }
    })()
    pending.set(driver, started)
    return started
  }
}
