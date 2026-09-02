import type { ConnectionOptions, SmtpConnection } from "./connection.ts"
import { createConnection } from "./connection.ts"
import { cancelledError } from "./errors.ts"

/** Options for the pool layer. A subset of `SmtpDriverOptions`. */
export interface PoolOptions {
  enabled: boolean
  maxConnections: number
  maxMessagesPerConnection: number
  idleTimeoutMs: number
  disposeGraceMs: number
  connection: ConnectionOptions
}

/** A queued `acquire()`, with both ways it can end. */
interface Waiter {
  deliver: (entry: Entry) => void
  fail: (error: unknown) => void
}

/** Entry wraps a `SmtpConnection` with pool bookkeeping. */
interface Entry {
  conn: SmtpConnection
  uses: number
  idleTimer?: ReturnType<typeof setTimeout>
}

/** A FIFO connection pool with graceful dispose. Fixes the v0 leak: both
 *  idle AND in-flight connections are tracked, so `dispose()` can wait on
 *  in-flight sends and then quit everything. */
export interface ConnectionPool {
  acquire: () => Promise<SmtpConnection>
  release: (conn: SmtpConnection, failed?: boolean) => Promise<void>
  dispose: () => Promise<void>
  size: () => { idle: number; inFlight: number; waiters: number }
}

export function createPool(options: PoolOptions): ConnectionPool {
  const idle = new Set<Entry>()
  const inFlight = new Map<SmtpConnection, Entry>()
  // A waiter carries both outcomes. It used to be a bare resolve function,
  // which meant a handoff that could not produce a connection had no way to
  // tell the caller — it was shifted off the queue and simply forgotten, so
  // the `acquire()` promise behind it never settled and the send hung.
  const waiters: Waiter[] = []
  let disposed = false
  let disposePromise: Promise<void> | null = null

  function scheduleIdleTimeout(entry: Entry): void {
    clearTimeout(entry.idleTimer)
    if (options.idleTimeoutMs <= 0) return
    entry.idleTimer = setTimeout(() => {
      if (idle.has(entry)) {
        idle.delete(entry)
        entry.conn.destroy()
      }
    }, options.idleTimeoutMs)
  }

  async function create(): Promise<Entry> {
    const conn = await createConnection(options.connection)
    return { conn, uses: 0 }
  }

  return {
    async acquire() {
      if (disposed) throw cancelledError("pool disposed")
      // 1. Reuse an idle entry.
      for (const entry of idle) {
        idle.delete(entry)
        clearTimeout(entry.idleTimer)
        if (!entry.conn.isOpen()) {
          entry.conn.destroy()
          continue
        }
        inFlight.set(entry.conn, entry)
        return entry.conn
      }
      // 2. If under the cap (or pooling disabled — always create a fresh one), create.
      if (!options.enabled || inFlight.size < options.maxConnections) {
        const entry = await create()
        inFlight.set(entry.conn, entry)
        return entry.conn
      }
      // 3. Otherwise wait for a release.
      return new Promise<SmtpConnection>((resolve, reject) => {
        waiters.push({
          deliver(entry) {
            if (disposed) {
              reject(cancelledError("pool disposed while waiting"))
              return
            }
            inFlight.set(entry.conn, entry)
            resolve(entry.conn)
          },
          fail: reject,
        })
      })
    },

    async release(conn, failed = false) {
      const entry = inFlight.get(conn)
      if (!entry) return
      inFlight.delete(conn)
      entry.uses++
      const shouldRecycle =
        failed ||
        disposed ||
        !options.enabled ||
        !conn.isOpen() ||
        (options.maxMessagesPerConnection > 0 && entry.uses >= options.maxMessagesPerConnection)
      if (shouldRecycle) {
        if (failed || !conn.isOpen()) conn.destroy()
        else {
          try {
            await conn.quit()
          } catch {
            /* ignore */
          }
        }
        // Try to hand a fresh connection to the next waiter.
        if (waiters.length > 0 && !disposed) {
          const next = waiters.shift()!
          try {
            next.deliver(await create())
          } catch (error) {
            // The provider stopped accepting connections. Fail this waiter
            // rather than drop it; capacity is free again, so the next
            // acquire creates directly and the queue keeps moving.
            next.fail(error)
          }
        }
        return
      }
      // Hand off to a waiter if present; otherwise park in idle.
      if (waiters.length > 0) {
        waiters.shift()!.deliver(entry)
        return
      }
      idle.add(entry)
      scheduleIdleTimeout(entry)
    },

    async dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      disposePromise = (async () => {
        // 1. Reject waiters.
        while (waiters.length > 0) {
          waiters.shift()!.fail(cancelledError("pool disposed"))
        }
        // 2. Wait a grace period for in-flight sends to finish naturally.
        const deadline = Date.now() + options.disposeGraceMs
        while (inFlight.size > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
        // 3. Close everything still around. Idle sockets get a polite QUIT;
        //    anything that overran the grace period is destroyed hard.
        const idleSnapshot = [...idle]
        const inFlightSnapshot = [...inFlight.values()]
        idle.clear()
        inFlight.clear()
        for (const e of inFlightSnapshot) {
          clearTimeout(e.idleTimer)
          e.conn.destroy()
        }
        await Promise.allSettled(
          idleSnapshot.map((e) => {
            clearTimeout(e.idleTimer)
            return e.conn.quit().catch(() => {})
          }),
        )
      })()
      return disposePromise
    },

    size() {
      return { idle: idle.size, inFlight: inFlight.size, waiters: waiters.length }
    },
  }
}
