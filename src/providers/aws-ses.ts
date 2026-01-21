import type { MessageTag, SendRawEmailCommandInput, SESClientConfig } from '@aws-sdk/client-ses'
import type { EmailAddress, EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import {
  GetSendQuotaCommand,

  SendRawEmailCommand,

  SESClient,

} from '@aws-sdk/client-ses'
import { createError, createRequiredError, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types - Re-export from AWS SDK
// ============================================================================

export type { SESClientConfig }

export interface AwsSesEmailOptions extends EmailOptions {
  configurationSetName?: string
  messageTags?: Record<string, string>
  sourceArn?: string
  returnPath?: string
  returnPathArn?: string
}

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = 'aws-ses'

// ============================================================================
// Provider Implementation
// ============================================================================

export const awsSesProvider: ProviderFactory<SESClientConfig, SESClient, AwsSesEmailOptions> = defineProvider((opts: SESClientConfig = {}) => {
  if (!opts.region) {
    throw createRequiredError(PROVIDER_NAME, 'region')
  }

  const options: SESClientConfig = { ...opts }

  let client: SESClient | null = null
  let isInitialized = false

  const getClient = (): SESClient => {
    if (!client) {
      client = new SESClient(options)
    }
    return client
  }

  const formatEmailAddress = (address: EmailAddress): string => {
    return address.name
      ? `${address.name} <${address.email}>`
      : address.email
  }

  const generateMimeMessage = (emailOptions: EmailOptions): string => {
    const boundary = `----=${crypto.randomUUID().replace(/-/g, '')}`
    const now = new Date().toString()
    const fromDomain = emailOptions.from.email.split('@')[1] ?? 'unknown.com'
    const messageId = `<${crypto.randomUUID().replace(/-/g, '')}@${fromDomain}>`

    let message = ''

    message += `From: ${formatEmailAddress(emailOptions.from)}\r\n`

    if (Array.isArray(emailOptions.to)) {
      message += `To: ${emailOptions.to.map(formatEmailAddress).join(', ')}\r\n`
    }
    else {
      message += `To: ${formatEmailAddress(emailOptions.to)}\r\n`
    }

    if (emailOptions.cc) {
      if (Array.isArray(emailOptions.cc)) {
        message += `Cc: ${emailOptions.cc.map(formatEmailAddress).join(', ')}\r\n`
      }
      else {
        message += `Cc: ${formatEmailAddress(emailOptions.cc)}\r\n`
      }
    }

    if (emailOptions.bcc) {
      if (Array.isArray(emailOptions.bcc)) {
        message += `Bcc: ${emailOptions.bcc.map(formatEmailAddress).join(', ')}\r\n`
      }
      else {
        message += `Bcc: ${formatEmailAddress(emailOptions.bcc)}\r\n`
      }
    }

    message += `Subject: ${emailOptions.subject}\r\n`
    message += `Date: ${now}\r\n`
    message += `Message-ID: ${messageId}\r\n`
    message += 'MIME-Version: 1.0\r\n'

    if (emailOptions.headers) {
      for (const [name, value] of Object.entries(emailOptions.headers)) {
        message += `${name}: ${value}\r\n`
      }
    }

    message += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`

    if (emailOptions.text) {
      message += `--${boundary}\r\n`
      message += 'Content-Type: text/plain; charset=UTF-8\r\n'
      message += 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
      message += `${emailOptions.text.replace(/([=\r\n])/g, '=$1')}\r\n\r\n`
    }

    if (emailOptions.html) {
      message += `--${boundary}\r\n`
      message += 'Content-Type: text/html; charset=UTF-8\r\n'
      message += 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
      message += `${emailOptions.html.replace(/([=\r\n])/g, '=$1')}\r\n\r\n`
    }

    message += `--${boundary}--\r\n`

    return message
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
        const sesClient = getClient()
        const command = new GetSendQuotaCommand({})
        const response = await sesClient.send(command)
        return typeof response.Max24HourSend === 'number'
      }
      catch {
        return false
      }
    },

    async validateCredentials(): Promise<boolean> {
      return this.isAvailable()
    },

    async sendEmail(emailOpts: AwsSesEmailOptions): Promise<Result<EmailResult>> {
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

        const sesClient = getClient()

        const rawMessage = generateMimeMessage(emailOpts)
        const encodedMessage = Buffer.from(rawMessage)

        const input: SendRawEmailCommandInput = {
          RawMessage: {
            Data: encodedMessage,
          },
        }

        if (emailOpts.configurationSetName) {
          input.ConfigurationSetName = emailOpts.configurationSetName
        }

        if (emailOpts.sourceArn) {
          input.SourceArn = emailOpts.sourceArn
        }

        if (emailOpts.returnPath) {
          input.Source = emailOpts.returnPath
        }

        if (emailOpts.returnPathArn) {
          input.ReturnPathArn = emailOpts.returnPathArn
        }

        if (emailOpts.messageTags && Object.keys(emailOpts.messageTags).length > 0) {
          input.Tags = Object.entries(emailOpts.messageTags).map(([name, value]): MessageTag => ({
            Name: name,
            Value: value,
          }))
        }

        const command = new SendRawEmailCommand(input)
        const response = await sesClient.send(command)

        return {
          success: true,
          data: {
            messageId: response.MessageId ?? '',
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
  }
})

export default awsSesProvider
