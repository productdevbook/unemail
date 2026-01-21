import type { EmailAddress, EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import * as https from 'node:https'
import { createError, createRequiredError, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types
// ============================================================================

export interface AwsSesOptions {
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  endpoint?: string
  maxAttempts?: number
  apiVersion?: string
  debug?: boolean
  timeout?: number
  retries?: number
}

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

const defaultOptions: Partial<AwsSesOptions> = {
  region: 'us-east-1',
  maxAttempts: 3,
  apiVersion: '2010-12-01',
}

// ============================================================================
// Provider Implementation
// ============================================================================

export const awsSesProvider: ProviderFactory<AwsSesOptions, any, AwsSesEmailOptions> = defineProvider((opts: AwsSesOptions = {} as AwsSesOptions) => {
  const options = { ...defaultOptions, ...opts }

  const debug = (message: string, ...args: any[]) => {
    if (options.debug) {
      console.log(`[AWS-SES] ${message}`, ...args)
    }
  }

  const createCanonicalRequest = (
    method: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    payload: string,
  ): string => {
    const canonicalQueryString = Object.keys(query)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key] ?? '')}`)
      .join('&')

    const canonicalHeaders = `${Object.keys(headers)
      .sort()
      .map(key => `${key.toLowerCase()}:${headers[key] ?? ''}`)
      .join('\n')}\n`

    const signedHeaders = Object.keys(headers)
      .sort()
      .map(key => key.toLowerCase())
      .join(';')

    const payloadHash = crypto
      .createHash('sha256')
      .update(payload)
      .digest('hex')

    return [
      method,
      path,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')
  }

  const createStringToSign = (
    timestamp: string,
    region: string,
    canonicalRequest: string,
  ): string => {
    const date = timestamp.substring(0, 8)
    const hash = crypto
      .createHash('sha256')
      .update(canonicalRequest)
      .digest('hex')

    return [
      'AWS4-HMAC-SHA256',
      timestamp,
      `${date}/${region}/ses/aws4_request`,
      hash,
    ].join('\n')
  }

  const calculateSignature = (
    secretKey: string,
    timestamp: string,
    region: string,
    stringToSign: string,
  ): string => {
    const date = timestamp.substring(0, 8)

    const kDate = crypto
      .createHmac('sha256', `AWS4${secretKey}`)
      .update(date)
      .digest()

    const kRegion = crypto
      .createHmac('sha256', kDate)
      .update(region)
      .digest()

    const kService = crypto
      .createHmac('sha256', kRegion)
      .update('ses')
      .digest()

    const kSigning = crypto
      .createHmac('sha256', kService)
      .update('aws4_request')
      .digest()

    return crypto
      .createHmac('sha256', kSigning)
      .update(stringToSign)
      .digest('hex')
  }

  const createAuthHeader = (
    accessKeyId: string,
    timestamp: string,
    region: string,
    headers: Record<string, string>,
    signature: string,
  ): string => {
    const date = timestamp.substring(0, 8)
    const signedHeaders = Object.keys(headers)
      .sort()
      .map(key => key.toLowerCase())
      .join(';')

    return [
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${date}/${region}/ses/aws4_request`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(', ')
  }

  const makeRequest = (
    action: string,
    params: Record<string, any>,
  ): Promise<any> => {
    if (!options.accessKeyId || !options.secretAccessKey) {
      debug('Missing required credentials: accessKeyId or secretAccessKey')
      throw createRequiredError(PROVIDER_NAME, ['accessKeyId', 'secretAccessKey'])
    }

    return new Promise((resolve, reject) => {
      try {
        const region = options.region || defaultOptions.region as string
        const apiVersion = options.apiVersion || defaultOptions.apiVersion
        const host = options.endpoint || `email.${region}.amazonaws.com`
        const path = '/'
        const method = 'POST'

        debug('Making request to AWS SES:', { action, region, host })

        const body = new URLSearchParams()
        body.append('Action', action)
        body.append('Version', apiVersion as string)

        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            body.append(key, String(value))
          }
        })

        const bodyString = body.toString()
        debug('Request body:', bodyString)

        const now = new Date()
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
        const _date = amzDate.substring(0, 8)

        const headers: Record<string, string> = {
          'Host': host,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyString).toString(),
          'X-Amz-Date': amzDate,
        }

        if (options.sessionToken) {
          headers['X-Amz-Security-Token'] = options.sessionToken
        }

        debug('Request headers:', headers)

        const canonicalRequest = createCanonicalRequest(
          method,
          path,
          {},
          headers,
          bodyString,
        )

        const stringToSign = createStringToSign(
          amzDate,
          region,
          canonicalRequest,
        )

        const signature = calculateSignature(
          options.secretAccessKey,
          amzDate,
          region,
          stringToSign,
        )

        headers.Authorization = createAuthHeader(
          options.accessKeyId,
          amzDate,
          region,
          headers,
          signature,
        )

        debug('Making HTTPS request to:', `https://${host}${path}`)

        const req = https.request(
          {
            host,
            path,
            method,
            headers,
          },
          (res) => {
            let data = ''

            debug('Response status:', res.statusCode)
            debug('Response headers:', res.headers)

            res.on('data', (chunk) => {
              data += chunk
            })

            res.on('end', () => {
              debug('Response data:', data)

              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                const result: Record<string, any> = {}

                if (action === 'SendRawEmail') {
                  const messageIdMatch = data.match(/<MessageId>(.*?)<\/MessageId>/)
                  if (messageIdMatch && messageIdMatch[1]) {
                    result.MessageId = messageIdMatch[1]
                    debug('Extracted MessageId:', result.MessageId)
                  }
                }
                else if (action === 'GetSendQuota') {
                  const maxMatch = data.match(/<Max24HourSend>(.*?)<\/Max24HourSend>/)
                  if (maxMatch && maxMatch[1]) {
                    result.Max24HourSend = Number.parseFloat(maxMatch[1])
                    debug('Extracted Max24HourSend:', result.Max24HourSend)
                  }
                }

                resolve(result)
              }
              else {
                const errorMatch = data.match(/<Message>(.*?)<\/Message>/)
                const errorMessage = errorMatch ? errorMatch[1] : 'Unknown AWS SES error'
                debug('AWS SES Error:', errorMessage)
                reject(new Error(`AWS SES API Error: ${errorMessage}`))
              }
            })
          },
        )

        req.on('error', (error) => {
          debug('Request error:', error.message)
          reject(error)
        })

        req.write(bodyString)
        req.end()
      }
      catch (error: any) {
        debug('makeRequest exception:', error.message)
        reject(error)
      }
    })
  }

  const formatEmailAddress = (address: EmailAddress): string => {
    return address.name
      ? `${address.name} <${address.email}>`
      : address.email
  }

  const generateMimeMessage = (emailOptions: EmailOptions): string => {
    const boundary = `----=${crypto.randomUUID().replace(/-/g, '')}`
    const now = new Date().toString()
    const messageId = `<${crypto.randomUUID().replace(/-/g, '')}@${emailOptions.from.email.split('@')[1]}>`

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

    initialize() {
      debug('Initializing AWS SES provider with options:', {
        region: options.region,
        accessKeyId: options.accessKeyId ? `***${options.accessKeyId.slice(-4)}` : undefined,
        secretAccessKey: options.secretAccessKey ? '***' : undefined,
        endpoint: options.endpoint,
      })
    },

    async isAvailable(): Promise<boolean> {
      try {
        const response = await makeRequest('GetSendQuota', {})
        return !!response.Max24HourSend
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
          throw createError(PROVIDER_NAME, `Invalid email options: ${validationErrors.join(', ')}`)
        }

        const params: Record<string, any> = {}

        if (emailOpts.configurationSetName) {
          params.ConfigurationSetName = emailOpts.configurationSetName
        }

        if (emailOpts.sourceArn) {
          params.SourceArn = emailOpts.sourceArn
        }

        if (emailOpts.returnPath) {
          params.ReturnPath = emailOpts.returnPath
        }

        if (emailOpts.returnPathArn) {
          params.ReturnPathArn = emailOpts.returnPathArn
        }

        if (emailOpts.messageTags && Object.keys(emailOpts.messageTags).length > 0) {
          Object.entries(emailOpts.messageTags).forEach(([name, value], index) => {
            params[`Tags.member.${index + 1}.Name`] = name
            params[`Tags.member.${index + 1}.Value`] = value
          })
        }

        const rawMessage = generateMimeMessage(emailOpts)

        const encodedMessage = Buffer.from(rawMessage).toString('base64')

        params['RawMessage.Data'] = encodedMessage

        const response = await makeRequest('SendRawEmail', params)

        return {
          success: true,
          data: {
            messageId: response.MessageId || '',
            sent: true,
            timestamp: new Date(),
            provider: PROVIDER_NAME,
            response,
          },
        }
      }
      catch (error: any) {
        return {
          success: false,
          error: createError(PROVIDER_NAME, `Failed to send email: ${error.message}`, { cause: error }),
        }
      }
    },

    getInstance: () => null,
  }
})

export default awsSesProvider
