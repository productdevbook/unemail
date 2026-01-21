import type { SendMailOptions, SentMessageInfo, Transporter } from 'nodemailer'
import type { EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import nodemailer from 'nodemailer'
import { createError, createRequiredError, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types
// ============================================================================

export type { SendMailOptions, SentMessageInfo, Transporter }

// SMTP Transport options - compatible with nodemailer's createTransport
export interface SmtpOptions {
  host: string
  port?: number
  secure?: boolean
  auth?: {
    user: string
    pass: string
    type?: 'login' | 'oauth2' | 'custom'
  }
  tls?: {
    rejectUnauthorized?: boolean
    servername?: string
  }
  pool?: boolean
  maxConnections?: number
  maxMessages?: number
  rateDelta?: number
  rateLimit?: number
  connectionTimeout?: number
  greetingTimeout?: number
  socketTimeout?: number
  dkim?: {
    domainName: string
    keySelector: string
    privateKey: string
  }
  service?: string
  name?: string
  localAddress?: string
  authMethod?: string
}

export interface SmtpEmailOptions extends EmailOptions {
  dsn?: {
    id?: string
    return?: 'headers' | 'full'
    notify?: Array<'success' | 'failure' | 'delay'>
    recipient?: string
  }
  priority?: 'high' | 'normal' | 'low'
  inReplyTo?: string
  references?: string | string[]
  listUnsubscribe?: string | { url: string, comment?: string }
  envelope?: {
    from?: string
    to?: string | string[]
  }
}

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = 'smtp'

// ============================================================================
// Provider Implementation
// ============================================================================

export const smtpProvider: ProviderFactory<SmtpOptions, Transporter, SmtpEmailOptions> = defineProvider((opts: SmtpOptions = {} as SmtpOptions) => {
  if (!opts.host) {
    throw createRequiredError(PROVIDER_NAME, 'host')
  }

  const options: SmtpOptions = { ...opts }

  let transporter: Transporter | null = null
  let isInitialized = false

  const getTransporter = (): Transporter => {
    if (!transporter) {
      transporter = nodemailer.createTransport(options as nodemailer.TransportOptions)
    }
    return transporter
  }

  return {
    name: PROVIDER_NAME,
    options,

    getInstance: () => getTransporter(),

    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      try {
        const transport = getTransporter()
        await transport.verify()
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
        const transport = getTransporter()
        await transport.verify()
        return true
      }
      catch {
        return false
      }
    },

    async sendEmail(emailOpts: SmtpEmailOptions): Promise<Result<EmailResult>> {
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

        const transport = getTransporter()

        // Format addresses
        const formatAddress = (addr: { email: string, name?: string }) =>
          addr.name ? `"${addr.name}" <${addr.email}>` : addr.email

        const formatAddresses = (addrs: { email: string, name?: string } | Array<{ email: string, name?: string }>) =>
          Array.isArray(addrs) ? addrs.map(formatAddress) : formatAddress(addrs)

        // Build mail options
        const mailOptions: SendMailOptions = {
          from: formatAddress(emailOpts.from),
          to: formatAddresses(emailOpts.to),
          subject: emailOpts.subject,
          text: emailOpts.text,
          html: emailOpts.html,
          headers: emailOpts.headers,
        }

        if (emailOpts.cc) {
          mailOptions.cc = formatAddresses(emailOpts.cc)
        }

        if (emailOpts.bcc) {
          mailOptions.bcc = formatAddresses(emailOpts.bcc)
        }

        if (emailOpts.replyTo) {
          mailOptions.replyTo = formatAddress(emailOpts.replyTo)
        }

        if (emailOpts.attachments && emailOpts.attachments.length > 0) {
          mailOptions.attachments = emailOpts.attachments.map(att => ({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType,
            contentDisposition: att.disposition as 'attachment' | 'inline' | undefined,
            cid: att.cid,
            path: att.path,
          }))
        }

        // SMTP-specific options
        if (emailOpts.dsn) {
          (mailOptions as Record<string, unknown>).dsn = emailOpts.dsn
        }

        if (emailOpts.priority) {
          mailOptions.priority = emailOpts.priority
        }

        if (emailOpts.inReplyTo) {
          mailOptions.inReplyTo = emailOpts.inReplyTo
        }

        if (emailOpts.references) {
          mailOptions.references = emailOpts.references
        }

        if (emailOpts.listUnsubscribe) {
          if (typeof emailOpts.listUnsubscribe === 'string') {
            mailOptions.list = {
              unsubscribe: emailOpts.listUnsubscribe,
            }
          }
          else {
            mailOptions.list = {
              unsubscribe: {
                url: emailOpts.listUnsubscribe.url,
                comment: emailOpts.listUnsubscribe.comment ?? '',
              },
            }
          }
        }

        if (emailOpts.envelope) {
          mailOptions.envelope = {
            from: emailOpts.envelope.from ?? false,
            to: Array.isArray(emailOpts.envelope.to) ? emailOpts.envelope.to : emailOpts.envelope.to ? [emailOpts.envelope.to] : [],
          }
        }

        const info = await transport.sendMail(mailOptions)

        return {
          success: true,
          data: {
            messageId: info.messageId,
            sent: true,
            timestamp: new Date(),
            provider: PROVIDER_NAME,
            response: info,
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

    async close(): Promise<void> {
      if (transporter) {
        transporter.close()
        transporter = null
        isInitialized = false
      }
    },
  }
})

export default smtpProvider
