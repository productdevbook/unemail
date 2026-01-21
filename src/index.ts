// Export builtin providers metadata
export {
  type BuiltinProviderName,
  type BuiltinProviderOptions,
  builtinProviders,
} from './_providers.ts'

// Export core email service
export { createEmailService, EmailService } from './email.ts'

// Export provider system
export { defineProvider } from './providers/utils/index.ts'

export type { Provider, ProviderFactory } from './providers/utils/index.ts'
// Export types
export * from './types.ts'

// Export utils
export * from './utils.ts'
