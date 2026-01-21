import type { EmailOptions, EmailResult, MaybePromise, Result } from '../../types.ts'

/**
 * Standard provider interface for email services
 */
export interface Provider<OptionsT = any, InstanceT = any, EmailOptionsT extends EmailOptions = EmailOptions> {
  name?: string
  options?: OptionsT
  getInstance?: () => InstanceT

  // Core methods
  initialize: (opts?: Record<string, any>) => MaybePromise<void>
  isAvailable: () => MaybePromise<boolean>

  // Email-specific methods
  sendEmail: (options: EmailOptionsT) => MaybePromise<Result<EmailResult>>
  validateCredentials?: () => MaybePromise<boolean>

  // Optional method to get email details by ID
  getEmail?: (id: string) => MaybePromise<Result<any>>
}

/**
 * Type for provider factory function
 */
export type ProviderFactory<OptionsT = any, InstanceT = any, EmailOptionsT extends EmailOptions = EmailOptions>
  = (opts?: OptionsT) => Provider<OptionsT, InstanceT, EmailOptionsT>

/**
 * Helper function to define an email provider
 */
export function defineProvider<OptionsT = any, InstanceT = any, EmailOptionsT extends EmailOptions = EmailOptions>(
  factory: ProviderFactory<OptionsT, InstanceT, EmailOptionsT>,
): ProviderFactory<OptionsT, InstanceT, EmailOptionsT> {
  return factory
}

interface ErrorOptions {
  cause?: Error
  code?: string
}

/**
 * Creates a formatted error message
 *
 * @param component The component where the error occurred
 * @param message Error message
 * @param opts Additional error options
 * @returns Error object
 */
export function createError(
  component: string,
  message: string,
  opts?: ErrorOptions,
): Error {
  const err = new Error(`[unemail] [${component}] ${message}`, opts)
  if (Error.captureStackTrace) {
    Error.captureStackTrace(err, createError)
  }
  return err
}

/**
 * Creates an error for missing required options
 *
 * @param component The component where the error occurred
 * @param name Name of the missing option(s)
 * @returns Error object
 */
export function createRequiredError(component: string, name: string | string[]): Error {
  if (Array.isArray(name)) {
    return createError(
      component,
      `Missing required options: ${name.map(n => `'${n}'`).join(', ')}`,
    )
  }
  return createError(component, `Missing required option: '${name}'`)
}
