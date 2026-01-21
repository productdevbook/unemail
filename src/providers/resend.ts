import type { EmailAddress, EmailOptions, EmailResult, EmailTag, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { createError, createRequiredError, generateMessageId, makeRequest, retry, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types
// ============================================================================

export interface ResendOptions {
  apiKey: string
  endpoint?: string
  timeout?: number
  retries?: number
  debug?: boolean
}

export interface ResendEmailTag extends EmailTag {
  name: string
  value: string
}

export interface ResendEmailOptions extends EmailOptions {
  templateId?: string
  templateData?: Record<string, any>
  scheduledAt?: Date | string
  tags?: ResendEmailTag[]
}

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = 'resend'
const DEFAULT_ENDPOINT = 'https://api.resend.com'
const DEFAULT_TIMEOUT = 30000
const DEFAULT_RETRIES = 3

// ============================================================================
// Helper Functions
// ============================================================================

function validateTag(tag: ResendEmailTag): string[] {
  const errors: string[] = []
  const validPattern = /^[\w-]+$/

  if (!validPattern.test(tag.name)) {
    errors.push(`Tag name '${tag.name}' must only contain ASCII letters, numbers, underscores, or dashes`)
  }

  if (tag.name.length > 256) {
    errors.push(`Tag name '${tag.name}' exceeds maximum length of 256 characters`)
  }

  if (!validPattern.test(tag.value)) {
    errors.push(`Tag value '${tag.value}' for tag '${tag.name}' must only contain ASCII letters, numbers, underscores, or dashes`)
  }

  return errors
}

// ============================================================================
// Provider Implementation
// ============================================================================

export const resendProvider: ProviderFactory<ResendOptions, any, ResendEmailOptions> = defineProvider((opts: ResendOptions = {} as ResendOptions) => {
  if (!opts.apiKey) {
    throw createRequiredError(PROVIDER_NAME, 'apiKey')
  }

  const options: Required<ResendOptions> = {
    debug: opts.debug || false,
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    retries: opts.retries || DEFAULT_RETRIES,
    apiKey: opts.apiKey,
    endpoint: opts.endpoint || DEFAULT_ENDPOINT,
  }

  let isInitialized = false

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

    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      try {
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

    async isAvailable(): Promise<boolean> {
      try {
        if (options.apiKey && options.apiKey.startsWith('re_')) {
          debug('API key format is valid, assuming Resend is available')
          return true
        }

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        }

        debug('Checking Resend API availability')

        const result = await makeRequest(
          `${options.endpoint}/domains`,
          {
            method: 'GET',
            headers,
            timeout: options.timeout,
          },
        )

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

        return result.success && result.data?.statusCode >= 200 && result.data?.statusCode < 300
      }
      catch (error) {
        debug('Error checking availability:', error)
        return false
      }
    },

    async sendEmail(emailOpts: ResendEmailOptions): Promise<Result<EmailResult>> {
      try {
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

        if (!isInitialized) {
          await this.initialize()
        }

        const formatRecipients = (addresses: EmailAddress | EmailAddress[]) => {
          if (Array.isArray(addresses)) {
            return addresses.map((address) => {
              return address.name ? `${address.name} <${address.email}>` : address.email
            })
          }
          return [addresses.name ? `${addresses.name} <${addresses.email}>` : addresses.email]
        }

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

        if (emailOpts.cc) {
          payload.cc = formatRecipients(emailOpts.cc)
        }

        if (emailOpts.bcc) {
          payload.bcc = formatRecipients(emailOpts.bcc)
        }

        if (emailOpts.replyTo) {
          payload.reply_to = emailOpts.replyTo.name
            ? `${emailOpts.replyTo.name} <${emailOpts.replyTo.email}>`
            : emailOpts.replyTo.email
        }

        if (emailOpts.templateId) {
          payload.template = emailOpts.templateId
          if (emailOpts.templateData) {
            payload.data = emailOpts.templateData
          }
        }

        if (emailOpts.scheduledAt) {
          payload.scheduled_at = typeof emailOpts.scheduledAt === 'string'
            ? emailOpts.scheduledAt
            : emailOpts.scheduledAt.toISOString()
        }

        if (emailOpts.tags && emailOpts.tags.length > 0) {
          const tagValidationErrors: string[] = []

          emailOpts.tags.forEach((tag) => {
            const errors = validateTag(tag)
            if (errors.length > 0) {
              tagValidationErrors.push(...errors)
            }
          })

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

        if (emailOpts.attachments && emailOpts.attachments.length > 0) {
          payload.attachments = emailOpts.attachments.map(attachment => ({
            filename: attachment.filename,
            content: typeof attachment.content === 'string'
              ? attachment.content
              : attachment.content.toString('base64'),
            content_type: attachment.contentType,
            path: attachment.path,
          }))
        }

        debug('Sending email via Resend API', {
          to: payload.to,
          subject: payload.subject,
        })

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        }

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

          let errorMessage = result.error?.message || 'Unknown error'

          if (result.data?.statusCode === 403) {
            errorMessage = 'Forbidden: The API key may not have permission to send emails from this address or to these recipients.'
          }
          else if (result.data?.statusCode === 429) {
            errorMessage = 'Too many requests: You are sending too many emails too quickly. Please slow down or upgrade your plan.'
          }

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

        const responseData = result.data.body
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

    async validateCredentials(): Promise<boolean> {
      return this.isAvailable()
    },

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

        if (!isInitialized) {
          await this.initialize()
        }

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        }

        debug('Retrieving email details', { id })

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

export default resendProvider
