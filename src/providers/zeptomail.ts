import type { EmailAddress, EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { createError, createRequiredError, generateMessageId, makeRequest, retry, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types
// ============================================================================

export interface ZeptomailOptions {
  token: string
  endpoint?: string
  timeout?: number
  retries?: number
  debug?: boolean
}

export interface ZeptomailEmailOptions extends EmailOptions {
  trackClicks?: boolean
  trackOpens?: boolean
  clientReference?: string
  mimeHeaders?: Record<string, string>
}

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = 'zeptomail'
const DEFAULT_ENDPOINT = 'https://api.zeptomail.com/v1.1'
const DEFAULT_TIMEOUT = 30000
const DEFAULT_RETRIES = 3

// ============================================================================
// Provider Implementation
// ============================================================================

export const zeptomailProvider: ProviderFactory<ZeptomailOptions, any, ZeptomailEmailOptions> = defineProvider((opts: ZeptomailOptions = {} as ZeptomailOptions) => {
  if (!opts.token) {
    throw createRequiredError(PROVIDER_NAME, 'token')
  }

  if (!opts.token.startsWith('Zoho-enczapikey ')) {
    throw createError(
      PROVIDER_NAME,
      'Token should be in the format "Zoho-enczapikey <your_api_key>"',
    )
  }

  const options: Required<ZeptomailOptions> = {
    debug: opts.debug || false,
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    retries: opts.retries || DEFAULT_RETRIES,
    token: opts.token,
    endpoint: opts.endpoint || DEFAULT_ENDPOINT,
  }

  let isInitialized = false

  const debug = (message: string, ...args: any[]) => {
    if (options.debug) {
      const _debugMsg = `[${PROVIDER_NAME}] ${message} ${args.map(arg => JSON.stringify(arg)).join(' ')}`
    }
  }

  return {
    name: PROVIDER_NAME,
    features: {
      attachments: true,
      html: true,
      templates: false,
      tracking: true,
      customHeaders: true,
      batchSending: false,
      scheduling: false,
      replyTo: true,
      tagging: false,
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

    async isAvailable(): Promise<boolean> {
      try {
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

    async sendEmail(emailOpts: ZeptomailEmailOptions): Promise<Result<EmailResult>> {
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

        const formatSingleAddress = (address: EmailAddress) => {
          return {
            address: address.email,
            name: address.name || undefined,
          }
        }

        const formatEmailAddresses = (addresses: EmailAddress | EmailAddress[]) => {
          const addressList = Array.isArray(addresses) ? addresses : [addresses]
          return addressList.map(addr => ({
            email_address: formatSingleAddress(addr),
          }))
        }

        const payload: Record<string, any> = {
          from: formatSingleAddress(emailOpts.from),
          to: formatEmailAddresses(emailOpts.to),
          subject: emailOpts.subject,
        }

        if (emailOpts.text) {
          payload.textbody = emailOpts.text
        }

        if (emailOpts.html) {
          payload.htmlbody = emailOpts.html
        }

        if (emailOpts.cc) {
          payload.cc = formatEmailAddresses(emailOpts.cc)
        }

        if (emailOpts.bcc) {
          payload.bcc = formatEmailAddresses(emailOpts.bcc)
        }

        if (emailOpts.replyTo) {
          payload.reply_to = [formatSingleAddress(emailOpts.replyTo)]
        }

        if (emailOpts.trackClicks !== undefined) {
          payload.track_clicks = emailOpts.trackClicks
        }

        if (emailOpts.trackOpens !== undefined) {
          payload.track_opens = emailOpts.trackOpens
        }

        if (emailOpts.clientReference) {
          payload.client_reference = emailOpts.clientReference
        }

        if (emailOpts.mimeHeaders && Object.keys(emailOpts.mimeHeaders).length > 0) {
          payload.mime_headers = Object.entries(emailOpts.mimeHeaders).reduce((acc, [key, value]) => {
            acc[key] = value
            return acc
          }, {} as Record<string, string>)
        }

        if (emailOpts.headers && Object.keys(emailOpts.headers).length > 0) {
          if (!payload.mime_headers) {
            payload.mime_headers = {}
          }

          Object.entries(emailOpts.headers).forEach(([key, value]) => {
            payload.mime_headers[key] = value
          })
        }

        if (emailOpts.attachments && emailOpts.attachments.length > 0) {
          payload.attachments = emailOpts.attachments.map((attachment) => {
            const attachmentData: Record<string, any> = {
              name: attachment.filename,
            }

            if (attachment.content) {
              attachmentData.content = typeof attachment.content === 'string'
                ? attachment.content
                : attachment.content.toString('base64')

              if (attachment.contentType) {
                attachmentData.mime_type = attachment.contentType
              }
            }
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

        const headers: Record<string, string> = {
          'Authorization': options.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }

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

          let errorMessage = result.error?.message || 'Unknown error'

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

        const responseData = result.data.body
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

    async validateCredentials(): Promise<boolean> {
      return this.isAvailable()
    },
  }
})

export default zeptomailProvider
