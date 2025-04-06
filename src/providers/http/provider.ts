import type { EmailResult, HttpEmailConfig, Result } from 'unemail/types'
import type { ProviderFactory } from '../provider.ts'
import type { HttpEmailOptions } from './types.ts'
import { createError, generateMessageId, makeRequest, validateEmailOptions } from 'unemail/utils'
import { defineProvider } from '../provider.ts'

// Constants
const PROVIDER_NAME = 'http'
const DEFAULT_METHOD = 'POST'
const DEFAULT_TIMEOUT = 30000

/**
 * HTTP Email Provider for sending emails via HTTP API
 */
export const httpProvider: ProviderFactory<HttpEmailConfig, any, HttpEmailOptions> = defineProvider((opts: HttpEmailConfig = {} as HttpEmailConfig) => {
  // Validate required options
  if (!opts.endpoint) {
    throw new Error('Missing required option: endpoint')
  }

  // Initialize with defaults
  const options: Required<HttpEmailConfig> = {
    endpoint: opts.endpoint,
    apiKey: opts.apiKey || '',
    method: opts.method || DEFAULT_METHOD,
    headers: opts.headers || {},
  }

  /**
   * Create standard headers for API requests
   */
  const getStandardHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    }

    // Add API key if provided
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`
    }

    return headers
  }

  /**
   * Format the request based on email options
   */
  const formatRequest = (emailOpts: HttpEmailOptions): Record<string, any> => {
    // Base payload with standard email fields
    const payload: Record<string, any> = {
      from: emailOpts.from.email,
      from_name: emailOpts.from.name,
      to: Array.isArray(emailOpts.to)
        ? emailOpts.to.map(r => r.email)
        : emailOpts.to.email,
      subject: emailOpts.subject,
      text: emailOpts.text,
      html: emailOpts.html,
    }

    // Add CC if present
    if (emailOpts.cc) {
      payload.cc = Array.isArray(emailOpts.cc)
        ? emailOpts.cc.map(r => r.email)
        : emailOpts.cc.email
    }

    // Add BCC if present
    if (emailOpts.bcc) {
      payload.bcc = Array.isArray(emailOpts.bcc)
        ? emailOpts.bcc.map(r => r.email)
        : emailOpts.bcc.email
    }

    // Add custom parameters if provided
    if (emailOpts.customParams) {
      Object.assign(payload, emailOpts.customParams)
    }

    return payload
  }

  let isInitialized = false

  return {
    name: PROVIDER_NAME,
    features: {
      attachments: false,
      html: true,
      templates: false,
      tracking: false,
      customHeaders: true,
      batchSending: false,
      tagging: false,
      scheduling: false,
      replyTo: false,
    },
    options,

    /**
     * Initialize the HTTP provider
     */
    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      // Check if the API endpoint is available
      if (!await this.isAvailable()) {
        throw new Error('API endpoint not available')
      }

      isInitialized = true
    },

    /**
     * Check if the HTTP endpoint is available
     */
    async isAvailable(): Promise<boolean> {
      try {
        // Use OPTIONS request to check if endpoint is available
        const result = await makeRequest(
          options.endpoint,
          {
            method: 'OPTIONS',
            headers: getStandardHeaders(),
            timeout: DEFAULT_TIMEOUT,
          },
        )

        // Success case
        if (result.success) {
          return true
        }

        // Special case: 4xx responses actually mean the endpoint exists but needs auth
        if (result.data?.statusCode && result.data.statusCode >= 400 && result.data.statusCode < 500) {
          return true
        }

        return false
      }
      catch (error) {
        // Check for 4xx errors - these actually mean the API exists but needs auth
        if (error instanceof Error) {
          const errorMsg = error.message
          if (errorMsg.includes('status 4') || errorMsg.includes('401') || errorMsg.includes('403')) {
            return true
          }
        }
        return false
      }
    },

    /**
     * Send email via HTTP API
     */
    async sendEmail(emailOpts: HttpEmailOptions): Promise<Result<EmailResult>> {
      try {
        // Validate email options first, before any other operations
        const validationErrors = validateEmailOptions(emailOpts)
        if (validationErrors.length > 0) {
          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              `Invalid email options: ${validationErrors.join(', ')}`,
            ),
          }
        }

        // Make sure the provider is initialized
        if (!isInitialized) {
          await this.initialize()
        }

        // Format headers
        const headers = getStandardHeaders()

        // Add custom headers from email options
        if (emailOpts.headers) {
          Object.assign(headers, emailOpts.headers)
        }

        // Format the request payload
        const payload = formatRequest(emailOpts)

        // Use endpoint override if provided
        const endpoint = emailOpts.endpointOverride || options.endpoint

        // Use method override if provided
        const method = emailOpts.methodOverride || options.method

        // Make the request
        const result = await makeRequest(
          endpoint,
          {
            method,
            headers,
            timeout: DEFAULT_TIMEOUT,
          },
          JSON.stringify(payload),
        )

        if (!result.success) {
          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              `Failed to send email: ${result.error?.message || 'Unknown error'}`,
              { cause: result.error },
            ),
          }
        }

        // Extract message ID from the response following various patterns
        let messageId
        const responseBody = result.data?.body
        if (responseBody) {
          messageId = responseBody.id
            || responseBody.messageId
            || (responseBody.data && (responseBody.data.id || responseBody.data.messageId))
        }

        // Fall back to generating a message ID if none found
        if (!messageId) {
          messageId = generateMessageId()
        }

        return {
          success: true,
          data: {
            messageId,
            sent: true,
            timestamp: new Date(),
            provider: PROVIDER_NAME,
            response: result.data?.body,
          },
        }
      }
      catch (error) {
        return {
          success: false,
          error: createError(
            PROVIDER_NAME,
            `Failed to send email: ${(error as Error).message}`,
            { cause: error as Error },
          ),
        }
      }
    },

    /**
     * Validate configuration
     */
    async validateCredentials(): Promise<boolean> {
      try {
        // Use GET request to validate credentials
        const result = await makeRequest(
          options.endpoint,
          {
            method: 'GET',
            headers: getStandardHeaders(),
            timeout: DEFAULT_TIMEOUT,
          },
        )

        // Consider API available if response is successful (2xx)
        if (result.data?.statusCode && result.data.statusCode >= 200 && result.data.statusCode < 300) {
          return true
        }
        return false
      }
      catch {
        return false
      }
    },
  }
})
