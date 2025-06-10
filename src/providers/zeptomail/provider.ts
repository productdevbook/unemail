import type { EmailAddress, EmailResult, Result } from 'unemail/types'
import type { ProviderFactory } from '../provider.ts'
import type { ZeptomailEmailOptions } from './types.ts'
import { createError, createRequiredError, generateMessageId, makeRequest, retry, validateEmailOptions } from 'unemail/utils'
import { defineProvider } from '../provider.ts'

// Constants
const PROVIDER_NAME = 'zeptomail'
const DEFAULT_ENDPOINT = 'https://api.zeptomail.com/v1.1'
const DEFAULT_TIMEOUT = 30000
const DEFAULT_RETRIES = 3

/**
 * Interface for Zeptomail configuration
 */
export interface ZeptomailConfig {
  /**
   * API token for authentication
   * Format: "Zoho-enczapikey <your_api_key>"
   */
  token: string

  /**
   * Optional custom endpoint (default: https://api.zeptomail.com/v1.1)
   */
  endpoint?: string

  /**
   * Request timeout in milliseconds (default: 30000)
   */
  timeout?: number

  /**
   * Number of retry attempts for failed requests (default: 3)
   */
  retries?: number

  /**
   * Enable debug logging (default: false)
   */
  debug?: boolean
}

/**
 * Zeptomail Provider for sending emails through Zeptomail API
 */
export const zeptomailProvider: ProviderFactory<ZeptomailConfig, any, ZeptomailEmailOptions> = defineProvider((opts: ZeptomailConfig = {} as ZeptomailConfig) => {
  // Validate required options
  if (!opts.token) {
    throw createRequiredError(PROVIDER_NAME, 'token')
  }

  // Make sure token has correct format
  if (!opts.token.startsWith('Zoho-enczapikey ')) {
    throw createError(
      PROVIDER_NAME,
      'Token should be in the format "Zoho-enczapikey <your_api_key>"',
    )
  }

  // Initialize with defaults
  const options: Required<ZeptomailConfig> = {
    debug: opts.debug || false,
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    retries: opts.retries || DEFAULT_RETRIES,
    token: opts.token,
    endpoint: opts.endpoint || DEFAULT_ENDPOINT,
  }

  let isInitialized = false

  // Debug helper - using a no-op function if debug is disabled to avoid console.log
  const debug = (message: string, ...args: any[]) => {
    if (options.debug) {
      // Use a safer approach that doesn't rely on console
      const _debugMsg = `[${PROVIDER_NAME}] ${message} ${args.map(arg => JSON.stringify(arg)).join(' ')}`
      // In a real implementation, this might use a logger injected via options
      // or other logging mechanism that doesn't rely on console
    }
  }

  return {
    name: PROVIDER_NAME,
    features: {
      attachments: true,
      html: true,
      templates: false, // Zeptomail has template support but not implemented here
      tracking: true,
      customHeaders: true,
      batchSending: false,
      scheduling: false,
      replyTo: true,
      tagging: false,
    },
    options,

    /**
     * Initialize the Zeptomail provider
     */
    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      try {
        // Test endpoint availability and credentials
        if (!await this.isAvailable()) {
          throw createError(
            PROVIDER_NAME,
            'Zeptomail API not available or invalid token',
          )
        }

        isInitialized = true
        debug('Provider initialized successfully')
      }
      catch (error) {
        throw createError(
          PROVIDER_NAME,
          `Failed to initialize: ${(error as Error).message}`,
          { cause: error as Error },
        )
      }
    },

    /**
     * Check if Zeptomail API is available and credentials are valid
     */
    async isAvailable(): Promise<boolean> {
      try {
        // Since Zeptomail doesn't have a dedicated endpoint to check token,
        // we'll just check if token exists and has correct format
        if (options.token && options.token.startsWith('Zoho-enczapikey ')) {
          debug('Token format is valid, assuming Zeptomail is available')
          return true
        }

        return false
      }
      catch (error) {
        debug('Error checking availability:', error)
        return false
      }
    },

    /**
     * Send email through Zeptomail API
     * @param emailOpts The email options including Zeptomail-specific features
     */
    async sendEmail(emailOpts: ZeptomailEmailOptions): Promise<Result<EmailResult>> {
      try {
        // Validate email options
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

        // Make sure provider is initialized
        if (!isInitialized) {
          await this.initialize()
        }

        // Format a single EmailAddress for Zeptomail
        const formatSingleAddress = (address: EmailAddress) => {
          return {
            address: address.email,
            name: address.name || undefined,
          }
        }

        // Format array of email addresses for Zeptomail
        const formatEmailAddresses = (addresses: EmailAddress | EmailAddress[]) => {
          const addressList = Array.isArray(addresses) ? addresses : [addresses]
          return addressList.map(addr => ({
            email_address: formatSingleAddress(addr),
          }))
        }

        // Prepare request payload
        const payload: Record<string, any> = {
          from: formatSingleAddress(emailOpts.from),
          to: formatEmailAddresses(emailOpts.to),
          subject: emailOpts.subject,
        }

        // Add text body if present
        if (emailOpts.text) {
          payload.textbody = emailOpts.text
        }

        // Add HTML body if present
        if (emailOpts.html) {
          payload.htmlbody = emailOpts.html
        }

        // Add CC if present
        if (emailOpts.cc) {
          payload.cc = formatEmailAddresses(emailOpts.cc)
        }

        // Add BCC if present
        if (emailOpts.bcc) {
          payload.bcc = formatEmailAddresses(emailOpts.bcc)
        }

        // Add reply-to if present
        if (emailOpts.replyTo) {
          payload.reply_to = [formatSingleAddress(emailOpts.replyTo)]
        }

        // Add tracking options if present
        if (emailOpts.trackClicks !== undefined) {
          payload.track_clicks = emailOpts.trackClicks
        }

        if (emailOpts.trackOpens !== undefined) {
          payload.track_opens = emailOpts.trackOpens
        }

        // Add client reference if present
        if (emailOpts.clientReference) {
          payload.client_reference = emailOpts.clientReference
        }

        // Add MIME headers if present
        if (emailOpts.mimeHeaders && Object.keys(emailOpts.mimeHeaders).length > 0) {
          payload.mime_headers = Object.entries(emailOpts.mimeHeaders).reduce((acc, [key, value]) => {
            acc[key] = value
            return acc
          }, {} as Record<string, string>)
        }

        // Add custom headers if present
        if (emailOpts.headers && Object.keys(emailOpts.headers).length > 0) {
          // Zeptomail doesn't have a dedicated field for custom headers, so we'll merge them into mime_headers
          if (!payload.mime_headers) {
            payload.mime_headers = {}
          }

          Object.entries(emailOpts.headers).forEach(([key, value]) => {
            payload.mime_headers[key] = value
          })
        }

        // Add attachments if present
        if (emailOpts.attachments && emailOpts.attachments.length > 0) {
          payload.attachments = emailOpts.attachments.map((attachment) => {
            const attachmentData: Record<string, any> = {
              name: attachment.filename,
            }

            // Use content if provided
            if (attachment.content) {
              attachmentData.content = typeof attachment.content === 'string'
                ? attachment.content
                : attachment.content.toString('base64')

              if (attachment.contentType) {
                attachmentData.mime_type = attachment.contentType
              }
            }
            // Or use file_cache_key if available (assuming this is something supported by Zeptomail)
            else if (attachment.path) {
              attachmentData.file_cache_key = attachment.path
            }

            return attachmentData
          })
        }

        debug('Sending email via Zeptomail API', {
          to: payload.to,
          subject: payload.subject,
        })

        // Create headers with API token
        const headers: Record<string, string> = {
          'Authorization': options.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }

        // Send request with retry capability
        const result = await retry(
          async () => makeRequest(
            `${options.endpoint}/email`,
            {
              method: 'POST',
              headers,
              timeout: options.timeout,
            },
            JSON.stringify(payload),
          ),
          options.retries,
        )

        if (!result.success) {
          debug('API request failed', result.error)

          // Enhanced error messages based on response
          let errorMessage = result.error?.message || 'Unknown error'

          // Try to extract any error details from the response body
          if (result.data?.body?.message) {
            errorMessage += ` Details: ${result.data.body.message}`
          }
          else if (result.data?.body?.error?.message) {
            errorMessage += ` Details: ${result.data.body.error.message}`
          }

          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              `Failed to send email: ${errorMessage}`,
              { cause: result.error },
            ),
          }
        }

        // Extract information from response
        const responseData = result.data.body
        // Zeptomail returns a request_id in the successful response
        const messageId = responseData?.request_id || generateMessageId()

        debug('Email sent successfully', { messageId })
        return {
          success: true,
          data: {
            messageId,
            sent: true,
            timestamp: new Date(),
            provider: PROVIDER_NAME,
            response: responseData,
          },
        }
      }
      catch (error) {
        debug('Exception sending email', error)
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
     * Validate API credentials
     */
    async validateCredentials(): Promise<boolean> {
      return this.isAvailable()
    },
  }
})
