import type { DriverFactory, EmailDriver } from "./types.ts"

/** Identity helper used to declare a driver factory with full type
 *  inference. Exists purely for TypeScript — there is no runtime effect.
 *
 *  ```ts
 *  export default defineDriver<MyOpts>((opts) => ({
 *    name: "my-driver",
 *    send(msg, ctx) { ... }
 *  }))
 *  ```
 */
export function defineDriver<TOpts = unknown, TInstance = unknown>(
  factory: (options?: TOpts) => EmailDriver<TOpts, TInstance>,
): DriverFactory<TOpts, TInstance> {
  return factory
}
