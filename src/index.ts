/**
 * `unemail` — a driver-based email library for TypeScript.
 *
 * The core is this module: a message normalizer, a middleware pipeline, and
 * a driver contract. Transports live under `unemail/drivers/<name>`,
 * middleware under `unemail/middleware`, rendering under `unemail/render`.
 * Nothing here imports a Node built-in, so the core runs unchanged on Node,
 * Bun, Deno, Cloudflare Workers, and in a browser.
 *
 * ```ts
 * import { createEmail } from "unemail"
 * import resend from "unemail/drivers/resend"
 * import { withRetry } from "unemail/middleware"
 *
 * const email = createEmail({
 *   driver: resend({ apiKey: process.env.RESEND_API_KEY! }),
 *   defaults: { from: "Acme <hi@acme.com>" },
 *   use: [withRetry()],
 * })
 *
 * const { data, error } = await email.send({
 *   to: "ada@example.com",
 *   subject: "Welcome",
 *   html: "<p>Glad you are here.</p>",
 * })
 * ```
 *
 * @module
 */

export {
  createEmail,
  type CreateEmailOptions,
  type Email,
  type SendStreamOptions,
} from "./core/email.ts"

export {
  compose,
  defineDriver,
  defineMiddleware,
  driverHandler,
  perMessage,
  wrap,
} from "./core/define.ts"

export {
  createError,
  createRequiredError,
  createUnsupportedError,
  EmailError,
  toEmailError,
} from "./core/error.ts"

export { err, isOk, ok, toBatchResult, unwrap } from "./core/result.ts"

export {
  dedupeAddresses,
  formatAddress,
  formatAddressList,
  isValidEmail,
  parseAddress,
  toAddressList,
} from "./core/address.ts"

export {
  getHeader,
  hasHeader,
  type MessageDefaults,
  normalizeMessage,
  patchMessage,
} from "./core/message.ts"

export type {
  AddressInput,
  Attachment,
  BatchResult,
  DriverFactory,
  DriverFeatures,
  DriverOf,
  DriverWithInstance,
  EmailAddress,
  EmailDriver,
  EmailErrorCode,
  EmailMessage,
  EmailResult,
  EmailTag,
  MaybePromise,
  MessageContent,
  Middleware,
  NormalizedMessage,
  Result,
  SendContext,
  SendHandler,
  SendState,
  SendStatus,
  TemplateOptions,
  TrackingOptions,
  UnsubscribeOptions,
} from "./core/types.ts"

/** The package version. Checked against `package.json` and `jsr.json` by
 *  `scripts/check-version.mjs`, which CI runs — the three cannot drift. */
export const version = "0.6.0"
