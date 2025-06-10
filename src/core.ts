import type {
  BaseConfig,
  EmailOptions,
  EmailResult,
  EmailServiceConfig,
  Result,
} from 'unemail/types'
import type { Provider, ProviderFactory } from './providers/provider.ts'
import smtpProvider from 'unemail/providers/smtp'
import { createError } from 'unemail/utils'

// Import default provider
// Instead of using mailcrab, use smtp provider as default
const DEFAULT_PROVIDER = smtpProvider

/**
 * Provider options - can be a provider factory, instance, or config with a provider name
 */
type ProviderOption<ConfigT = any, InstanceT = any, OptsT extends EmailOptions = EmailOptions>
  = | Provider<ConfigT, InstanceT, OptsT> // Direct provider instance
    | ProviderFactory<ConfigT, InstanceT, OptsT> // Provider factory function
    | { name: string, options?: Record<string, any> } // Legacy provider by name

interface EmailServiceOptions<ConfigT = any, InstanceT = any, OptsT extends EmailOptions = EmailOptions> extends BaseConfig {
  provider?: ProviderOption<ConfigT, InstanceT, OptsT>
  config?: EmailServiceConfig
}

/**
 * Main email service class
 */
export class EmailService<OptsT extends EmailOptions = EmailOptions> {
  private provider!: Provider<any, any, OptsT>
  private options: EmailServiceOptions<any, any, OptsT>
  private initialized: boolean = false

  /**
   * Creates a new email service instance
   *
   * @param options Configuration options for the email service
   */
  constructor(options: EmailServiceOptions<any, any, OptsT> = {} as EmailServiceOptions<any, any, OptsT>) {
    this.options = {
      debug: options.debug || false,
      timeout: options.timeout || 30000,
      retries: options.retries || 3,
      provider: options.provider,
      config: options.config,
    }
  }

  /**
   * Get the provider instance
   */
  private async getProvider(): Promise<Provider<any, any, OptsT>> {
    if (!this.provider) {
      try {
        const providerOption = this.options.provider || DEFAULT_PROVIDER

        // Note: We removed the 'string' case since DEFAULT_PROVIDER is now a function
        if (typeof providerOption === 'function') {
          // Provider factory function
          const config = this.options.config?.options || {}

          // When using the default SMTP provider, ensure we have at least a default host and port
          if (providerOption === DEFAULT_PROVIDER && !('host' in config)) {
            // Add minimal required fields for SmtpConfig when using default provider
            (config as any).host = 'localhost';
            (config as any).port = 1025 // Default MailCrab port
          }

          this.provider = providerOption(config as any)
        }
        else if (providerOption && typeof providerOption === 'object' && 'initialize' in providerOption) {
          // Direct provider instance
          this.provider = providerOption as Provider<any, any, OptsT>
        }
        else if (providerOption && typeof providerOption === 'object' && 'name' in providerOption) {
          // Legacy format with name and options
          throw new Error(`Provider specification with name property is no longer supported. Please import the provider directly and pass the provider instance or factory.`)
        }
        else {
          throw new Error('Invalid provider configuration. Please provide a valid provider instance or factory function.')
        }
      }
      catch (error) {
        throw createError(
          'core',
          `Failed to initialize provider: ${(error as Error).message}`,
          { cause: error as Error },
        )
      }
    }
    return this.provider
  }

  /**
   * Initializes the email service and underlying provider
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    try {
      const provider = await this.getProvider()
      await provider.initialize()
      this.initialized = true
    }
    catch (error) {
      throw createError(
        'core',
        `Failed to initialize email service: ${(error as Error).message}`,
        { cause: error as Error },
      )
    }
  }

  /**
   * Checks if the configured provider is available
   *
   * @returns Promise resolving to a boolean indicating availability
   */
  async isAvailable(): Promise<boolean> {
    try {
      const provider = await this.getProvider()
      return await provider.isAvailable()
    }
    catch (error) {
      if (this.options.debug) {
        console.error('Error checking provider availability:', error)
      }
      return false
    }
  }

  /**
   * Sends an email using the configured provider
   *
   * @param options Email sending options
   * @returns Promise resolving to email result
   */
  async sendEmail(options: OptsT): Promise<Result<EmailResult>> {
    try {
      // Ensure service is initialized
      if (!this.initialized) {
        await this.initialize()
      }

      // Get provider and send email
      const provider = await this.getProvider()
      return await provider.sendEmail(options)
    }
    catch (error) {
      return {
        success: false,
        error: createError(
          'core',
          `Failed to send email: ${(error as Error).message}`,
          { cause: error as Error },
        ),
      }
    }
  }

  /**
   * Validates credentials for the current provider
   *
   * @returns Promise resolving to a boolean indicating if credentials are valid
   */
  async validateCredentials(): Promise<boolean> {
    try {
      // Ensure service is initialized
      if (!this.initialized) {
        await this.initialize()
      }

      // Get provider
      const provider = await this.getProvider()

      // Validate credentials if provider supports it
      if (provider.validateCredentials) {
        return await provider.validateCredentials()
      }

      // Assume valid if provider doesn't implement validation
      return true
    }
    catch (error) {
      if (this.options.debug) {
        console.error('Error validating credentials:', error)
      }
      return false
    }
  }
}

/**
 * Creates an email service with the given configuration
 *
 * @param options Configuration options for the email service
 * @returns Configured email service instance
 */
export function createEmailService<OptsT extends EmailOptions = EmailOptions>(
  options: EmailServiceOptions<any, any, OptsT> = {} as EmailServiceOptions<any, any, OptsT>,
): EmailService<OptsT> {
  return new EmailService<OptsT>(options)
}
