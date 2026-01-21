import type { Attachment, CreateEmailOptions, Tag } from 'resend'
import type { EmailOptions, EmailResult, EmailTag, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { Buffer } from 'node:buffer'
import { Resend } from 'resend'
import { createError, createRequiredError, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types - Re-export from resend
// ============================================================================

export type { Attachment, CreateEmailOptions, Tag }

export interface ResendOptions {
  apiKey: string
}

export interface ResendEmailTag extends EmailTag {
  name: string
  value: string
}

export interface ResendEmailOptions extends EmailOptions {
  templateId?: string
  templateData?: Record<string, unknown>
  scheduledAt?: Date | string
  tags?: ResendEmailTag[]
}

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = 'resend'

// ============================================================================
// Provider Implementation
// ============================================================================

export const resendProvider: ProviderFactory<ResendOptions, Resend, ResendEmailOptions> = defineProvider((opts: ResendOptions = {} as ResendOptions) => {
  if (!opts.apiKey) {
    throw createRequiredError(PROVIDER_NAME, 'apiKey')
  }

  const options: ResendOptions = { ...opts }

  let client: Resend | null = null
  let isInitialized = false

  const getClient = (): Resend => {
    if (!client) {
      client = new Resend(options.apiKey)
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
        // Validate API key format
        if (!options.apiKey.startsWith('re_')) {
          throw createError(PROVIDER_NAME, 'Invalid API key format')
        }
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
        if (options.apiKey && options.apiKey.startsWith('re_')) {
          return true
        }
        return false
      }
      catch {
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

        const resend = getClient()

        // Format addresses
        const formatAddress = (addr: { email: string, name?: string }) =>
          addr.name ? `${addr.name} <${addr.email}>` : addr.email

        const formatAddresses = (addrs: { email: string, name?: string } | Array<{ email: string, name?: string }>) =>
          Array.isArray(addrs) ? addrs.map(formatAddress) : [formatAddress(addrs)]

        // Build request payload - ensure text is always provided
        const payload: CreateEmailOptions = {
          from: formatAddress(emailOpts.from),
          to: formatAddresses(emailOpts.to),
          subject: emailOpts.subject,
          text: emailOpts.text ?? '',
        }

        if (emailOpts.html) {
          payload.html = emailOpts.html
        }

        if (emailOpts.headers) {
          payload.headers = emailOpts.headers
        }

        if (emailOpts.cc) {
          payload.cc = formatAddresses(emailOpts.cc)
        }

        if (emailOpts.bcc) {
          payload.bcc = formatAddresses(emailOpts.bcc)
        }

        if (emailOpts.replyTo) {
          payload.replyTo = [formatAddress(emailOpts.replyTo)]
        }

        if (emailOpts.scheduledAt) {
          payload.scheduledAt = typeof emailOpts.scheduledAt === 'string'
            ? emailOpts.scheduledAt
            : emailOpts.scheduledAt.toISOString()
        }

        if (emailOpts.tags && emailOpts.tags.length > 0) {
          payload.tags = emailOpts.tags.map((tag): Tag => ({
            name: tag.name,
            value: tag.value,
          }))
        }

        if (emailOpts.attachments && emailOpts.attachments.length > 0) {
          payload.attachments = emailOpts.attachments.map((att): Attachment => ({
            filename: att.filename,
            content: typeof att.content === 'string'
              ? att.content
              : att.content instanceof Buffer
                ? att.content
                : undefined,
            contentType: att.contentType,
            path: att.path,
          }))
        }

        const { data, error } = await resend.emails.send(payload)

        if (error) {
          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              `Failed to send email: ${error.message}`,
            ),
          }
        }

        return {
          success: true,
          data: {
            messageId: data?.id ?? '',
            sent: true,
            timestamp: new Date(),
            provider: PROVIDER_NAME,
            response: data,
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

    async getEmail(id: string): Promise<Result<unknown>> {
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

        const resend = getClient()
        const { data, error } = await resend.emails.get(id)

        if (error) {
          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              `Failed to retrieve email: ${error.message}`,
            ),
          }
        }

        return {
          success: true,
          data,
        }
      }
      catch (error) {
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
