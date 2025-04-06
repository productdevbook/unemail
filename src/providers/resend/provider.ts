import type { EmailAddress, EmailResult, ResendConfig, Result } from 'unemail/types'
import type { ProviderFactory } from '../provider.ts'
import type { ResendEmailOptions, ResendEmailTag } from './types.ts'
import { createError, createRequiredError, generateMessageId, makeRequest, retry, validateEmailOptions } from 'unemail/utils'
import { defineProvider } from '../provider.ts'

// Constants
const PROVIDER_NAME = 'resend'
const DEFAULT_ENDPOINT = 'https://api.resend.com'
const DEFAULT_TIMEOUT = 30000
const DEFAULT_RETRIES = 3

/**
 * Validates tag format for Resend API
 * Tags can only contain ASCII letters, numbers, underscores, or dashes
 */
function validateTag(tag: ResendEmailTag): string[] {
  const errors: string[] = []
  const validPattern = /^[\w-]+$/

  // Check name format
  if (!validPattern.test(tag.name)) {
    errors.push(`Tag name '${tag.name}' must only contain ASCII letters, numbers, underscores, or dashes`)
  }

  // Check name length (max 256 chars according to Resend docs)
  if (tag.name.length > 256) {
    errors.push(`Tag name '${tag.name}' exceeds maximum length of 256 characters`)
  }

  // Check value format
  if (!validPattern.test(tag.value)) {
    errors.push(`Tag value '${tag.value}' for tag '${tag.name}' must only contain ASCII letters, numbers, underscores, or dashes`)
  }

  return errors
}

/**
 * Resend Provider for sending emails through Resend API
 */
export const resendProvider: ProviderFactory<ResendConfig, any, ResendEmailOptions> = defineProvider((opts: ResendConfig = {} as ResendConfig) => {
  // Validate required options
  if (!opts.apiKey) {
    throw createRequiredError(PROVIDER_NAME, 'apiKey')
  }

  // Initialize with defaults
  const options: Required<ResendConfig> = {
    debug: opts.debug || false,
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    retries: opts.retries || DEFAULT_RETRIES,
    apiKey: opts.apiKey,
    endpoint: opts.endpoint || DEFAULT_ENDPOINT,
  }

  let isInitialized = false

  // Debug helper
  const debug = (message: string, ...args: any[]) => {
    if (options.debug) {
      console.log(`[${PROVIDER_NAME}] ${message}`, ...args)
    }
  }

  return {
    name: PROVIDER_NAME,
    features: {
      attachments: true,
      html: true,
      templates: true,
      tracking: true,
      customHeaders: true,
      batchSending: true,
      scheduling: true,
      replyTo: true,
      tagging: true,
    },
    options,

    /**
     * Initialize the Resend provider
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
            'Resend API not available or invalid API key',
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
     * Check if Resend API is available and credentials are valid
     */
    async isAvailable(): Promise<boolean> {
      try {
        // For restricted API keys that can only send emails,
        // we can't use the /domains endpoint, so we'll just check if API key exists
        if (options.apiKey && options.apiKey.startsWith('re_')) {
          debug('API key format is valid, assuming Resend is available')
          return true
        }

        // If we want to do a full check for unrestricted keys (not needed for most use cases)
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        }

        debug('Checking Resend API availability')

        // Try to access an endpoint that requires less permissions
        const result = await makeRequest(
          `${options.endpoint}/domains`,
          {
            method: 'GET',
            headers,
            timeout: options.timeout,
          },
        )

        // For restricted API keys, a 401 with a specific message is actually OK
        if (
          result.data?.statusCode === 401
          && result.data?.body?.name === 'restricted_api_key'
          && result.data?.body?.message?.includes('restricted to only send emails')
        ) {
          debug('API key is valid but restricted to only sending emails')
          return true
        }

        debug('Resend API availability check response:', {
          statusCode: result.data?.statusCode,
          success: result.success,
          error: result.error?.message,
        })

        // For unrestricted API keys, check for 200 OK
        return result.success && result.data?.statusCode >= 200 && result.data?.statusCode < 300
      }
      catch (error) {
        debug('Error checking availability:', error)
        return false
      }
    },

    /**
     * Send email through Resend API
     * @param emailOpts The email options including Resend-specific features
     */
    async sendEmail(emailOpts: ResendEmailOptions): Promise<Result<EmailResult>> {
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

        // Format recipients for Resend API
        const formatRecipients = (addresses: EmailAddress | EmailAddress[]) => {
          if (Array.isArray(addresses)) {
            return addresses.map((address) => {
              return address.name ? `${address.name} <${address.email}>` : address.email
            })
          }
          return [addresses.name ? `${addresses.name} <${addresses.email}>` : addresses.email]
        }

        // Prepare request payload
        const payload: Record<string, any> = {
          from: emailOpts.from.name
            ? `${emailOpts.from.name} <${emailOpts.from.email}>`
            : emailOpts.from.email,
          to: formatRecipients(emailOpts.to),
          subject: emailOpts.subject,
          text: emailOpts.text,
          html: emailOpts.html,
          headers: emailOpts.headers || {},
        }

        // Add CC if present
        if (emailOpts.cc) {
          payload.cc = formatRecipients(emailOpts.cc)
        }

        // Add BCC if present
        if (emailOpts.bcc) {
          payload.bcc = formatRecipients(emailOpts.bcc)
        }

        // Add reply-to if present
        if (emailOpts.replyTo) {
          payload.reply_to = emailOpts.replyTo.name
            ? `${emailOpts.replyTo.name} <${emailOpts.replyTo.email}>`
            : emailOpts.replyTo.email
        }

        // Add template id and data if present
        if (emailOpts.templateId) {
          payload.template = emailOpts.templateId
          if (emailOpts.templateData) {
            payload.data = emailOpts.templateData
          }
        }

        // Add scheduled_at if present
        if (emailOpts.scheduledAt) {
          payload.scheduled_at = typeof emailOpts.scheduledAt === 'string'
            ? emailOpts.scheduledAt
            : emailOpts.scheduledAt.toISOString()
        }

        // Add tags if present - with validation
        if (emailOpts.tags && emailOpts.tags.length > 0) {
          // Validate tags format first
          const tagValidationErrors: string[] = []

          emailOpts.tags.forEach((tag) => {
            const errors = validateTag(tag)
            if (errors.length > 0) {
              tagValidationErrors.push(...errors)
            }
          })

          // Return validation errors if any found
          if (tagValidationErrors.length > 0) {
            return {
              success: false,
              error: createError(
                PROVIDER_NAME,
                `Invalid email tags: ${tagValidationErrors.join(', ')}`,
              ),
            }
          }

          payload.tags = emailOpts.tags.map(tag => ({
            name: tag.name,
            value: tag.value,
          }))
        }

        // Add attachments if present
        if (emailOpts.attachments && emailOpts.attachments.length > 0) {
          payload.attachments = emailOpts.attachments.map(attachment => ({
            filename: attachment.filename,
            content: typeof attachment.content === 'string'
              ? attachment.content
              : attachment.content.toString('base64'),
            content_type: attachment.contentType, // Added content type support
            path: attachment.path, // Added path support
          }))
        }

        debug('Sending email via Resend API', {
          to: payload.to,
          subject: payload.subject,
        })

        // Create headers with API key
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        }

        // Send request with retry capability
        const result = await retry(
          async () => makeRequest(
            `${options.endpoint}/emails`,
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

          // Enhanced error messages based on common Resend status codes
          let errorMessage = result.error?.message || 'Unknown error'

          if (result.data?.statusCode === 403) {
            errorMessage = 'Forbidden: The API key may not have permission to send emails from this address or to these recipients.'
          }
          else if (result.data?.statusCode === 429) {
            errorMessage = 'Too many requests: You are sending too many emails too quickly. Please slow down or upgrade your plan.'
          }

          // Try to extract any error details from the response body
          if (result.data?.body?.message) {
            errorMessage += ` Details: ${result.data.body.message}`
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

        // Extract message ID from response or generate one
        const responseData = result.data.body
        // Resend returns { id: "..." } for successful sends
        const messageId = responseData?.id || generateMessageId()

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

    /**
     * Retrieve email by ID
     * @param id Email ID to retrieve
     * @returns Email details
     */
    async getEmail(id: string): Promise<Result<any>> {
      try {
        if (!id) {
          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              'Email ID is required to retrieve email details',
            ),
          }
        }

        // Make sure provider is initialized
        if (!isInitialized) {
          await this.initialize()
        }

        // Create headers with API key
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        }

        debug('Retrieving email details', { id })

        // Send request with retry capability
        const result = await retry(
          async () => makeRequest(
            `${options.endpoint}/emails/${id}`,
            {
              method: 'GET',
              headers,
              timeout: options.timeout,
            },
          ),
          options.retries,
        )

        if (!result.success) {
          debug('API request failed when retrieving email', result.error)
          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              `Failed to retrieve email: ${result.error?.message || 'Unknown error'}`,
              { cause: result.error },
            ),
          }
        }

        debug('Email details retrieved successfully')
        return {
          success: true,
          data: result.data.body,
        }
      }
      catch (error) {
        debug('Exception retrieving email', error)
        return {
          success: false,
          error: createError(
            PROVIDER_NAME,
            `Failed to retrieve email: ${(error as Error).message}`,
            { cause: error as Error },
          ),
        }
      }
    },
  }
})
