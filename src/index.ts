import type { Provider, ProviderFactory } from './providers/provider.ts'

// Export core email service
import { createEmailService, EmailService } from './core.ts'

// Export provider system
import { defineProvider } from './providers/provider.ts'

// Export all providers directly
export * from './providers/index.ts'

// Main export
export {
  createEmailService,
  // Provider system
  defineProvider,
  // Core
  EmailService,

  type Provider,
  type ProviderFactory,
}
