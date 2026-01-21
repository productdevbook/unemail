import type { EmailAddress, EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { SendMailClient } from 'zeptomail'
import { createError, createRequiredError, generateMessageId, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types
// ============================================================================

export interface ZeptomailOptions {
  token: string
  url?: string
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
const DEFAULT_URL = 'api.zeptomail.com/'

// ============================================================================
// Provider Implementation
// ============================================================================

export const zeptomailProvider: ProviderFactory<ZeptomailOptions, SendMailClient, ZeptomailEmailOptions> = defineProvider((opts: ZeptomailOptions = {} as ZeptomailOptions) => {
  if (!opts.token) {
    throw createRequiredError(PROVIDER_NAME, 'token')
  }

  const options: ZeptomailOptions = {
    token: opts.token,
    url: opts.url ?? DEFAULT_URL,
  }

  let client: SendMailClient | null = null
  let isInitialized = false

  const getClient = (): SendMailClient => {
    if (!client) {
      client = new SendMailClient({
        url: options.url!,
        token: options.token,
      })
    }
    return client
  }

  return {
    name: PROVIDER_NAME,
    options,

    getInstance: () => getClient(),

    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      try {
        getClient()
        isInitialized = true
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
        // Zeptomail doesn't have a health check endpoint
        // We assume it's available if we can create a client
        getClient()
        return true
      }
      catch {
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

        const zeptoClient = getClient()

        const formatSingleAddress = (address: EmailAddress) => ({
          address: address.email,
          name: address.name,
        })

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
          payload.mime_headers = { ...emailOpts.mimeHeaders }
        }

        if (emailOpts.headers && Object.keys(emailOpts.headers).length > 0) {
          payload.mime_headers = {
            ...payload.mime_headers,
            ...emailOpts.headers,
          }
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

        const response = await zeptoClient.sendMail(payload as any)

        const messageId = response?.request_id || generateMessageId()

        return {
          success: true,
          data: {
            messageId,
            sent: true,
            timestamp: new Date(),
            provider: PROVIDER_NAME,
            response,
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

    async validateCredentials(): Promise<boolean> {
      return this.isAvailable()
    },
  }
})

export default zeptomailProvider
