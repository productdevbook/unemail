import type {
  AwsSesConfig,
  EmailAddress,
  EmailOptions,
  EmailResult,
  Result,
} from 'unemail/types'
import type { ProviderFactory } from '../provider.ts'
import type { AwsSesEmailOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import * as https from 'node:https'
import { createError, createRequiredError, validateEmailOptions } from 'unemail/utils'
import { defineProvider } from '../provider.ts'

const PROVIDER_NAME = 'aws-ses'

/**
 * Default options for AWS SES provider
 */
const defaultOptions: Partial<AwsSesConfig> = {
  region: 'us-east-1',
  maxAttempts: 3,
  apiVersion: '2010-12-01',
}

/**
 * AWS SES Email Provider Implementation - Zero dependency version
 * Uses native Node.js APIs instead of AWS SDK
 */
export const awsSesProvider: ProviderFactory<AwsSesConfig, any, AwsSesEmailOptions> = defineProvider((opts: AwsSesConfig = {} as AwsSesConfig) => {
  // Merge with defaults
  const options = { ...defaultOptions, ...opts }

  // Debug helper
  const debug = (message: string, ...args: any[]) => {
    if (options.debug) {
      console.log(`[AWS-SES] ${message}`, ...args)
    }
  }

  /**
   * Create canonical request for AWS Signature V4
   */
  const createCanonicalRequest = (
    method: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    payload: string,
  ): string => {
    const canonicalQueryString = Object.keys(query)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
      .join('&')

    const canonicalHeaders = `${Object.keys(headers)
      .sort()
      .map(key => `${key.toLowerCase()}:${headers[key]}`)
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

  /**
   * Create string to sign for AWS Signature V4
   */
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

  /**
   * Calculate AWS Signature V4
   */
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

  /**
   * Create AWS SES authorization header
   */
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

  /**
   * Make an HTTP request to AWS SES API
   */
  const makeRequest = (
    action: string,
    params: Record<string, any>,
  ): Promise<any> => {
    // Validate required credentials
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

        // Prepare request body
        const body = new URLSearchParams()
        body.append('Action', action)
        body.append('Version', apiVersion as string)

        // Add parameters to body
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            body.append(key, String(value))
          }
        })

        const bodyString = body.toString()
        debug('Request body:', bodyString)

        // Create timestamp for signing
        const now = new Date()
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
        // Unused variable, prefix with underscore
        const _date = amzDate.substring(0, 8)

        // Prepare headers for signing
        const headers: Record<string, string> = {
          'Host': host,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyString).toString(),
          'X-Amz-Date': amzDate,
        }

        // Add session token if provided
        if (options.sessionToken) {
          headers['X-Amz-Security-Token'] = options.sessionToken
        }

        debug('Request headers:', headers)

        // Create canonical request
        const canonicalRequest = createCanonicalRequest(
          method,
          path,
          {},
          headers,
          bodyString,
        )

        // Create string to sign
        const stringToSign = createStringToSign(
          amzDate,
          region,
          canonicalRequest,
        )

        // Calculate signature
        const signature = calculateSignature(
          options.secretAccessKey,
          amzDate,
          region,
          stringToSign,
        )

        // Create authorization header
        headers.Authorization = createAuthHeader(
          options.accessKeyId,
          amzDate,
          region,
          headers,
          signature,
        )

        debug('Making HTTPS request to:', `https://${host}${path}`)

        // Create HTTPS request
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
                // Parse XML response (simple parsing for common patterns)
                const result: Record<string, any> = {}

                // Extract common SES response patterns
                // This is a simplified parser that extracts just what we need
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
                // Extract error from XML
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

        // Send the request
        req.write(bodyString)
        req.end()
      }
      catch (error: any) {
        debug('makeRequest exception:', error.message)
        reject(error)
      }
    })
  }

  /**
   * Format email address for email headers
   */
  const formatEmailAddress = (address: EmailAddress): string => {
    return address.name
      ? `${address.name} <${address.email}>`
      : address.email
  }

  /**
   * Generate MIME message for email
   */
  const generateMimeMessage = (options: EmailOptions): string => {
    // Generate a boundary string for MIME parts
    const boundary = `----=${crypto.randomUUID().replace(/-/g, '')}`
    const now = new Date().toString()
    const messageId = `<${crypto.randomUUID().replace(/-/g, '')}@${options.from.email.split('@')[1]}>`

    let message = ''

    // Add email headers
    message += `From: ${formatEmailAddress(options.from)}\r\n`

    // Add To header
    if (Array.isArray(options.to)) {
      message += `To: ${options.to.map(formatEmailAddress).join(', ')}\r\n`
    }
    else {
      message += `To: ${formatEmailAddress(options.to)}\r\n`
    }

    // Add CC if present
    if (options.cc) {
      if (Array.isArray(options.cc)) {
        message += `Cc: ${options.cc.map(formatEmailAddress).join(', ')}\r\n`
      }
      else {
        message += `Cc: ${formatEmailAddress(options.cc)}\r\n`
      }
    }

    // Add BCC if present
    if (options.bcc) {
      if (Array.isArray(options.bcc)) {
        message += `Bcc: ${options.bcc.map(formatEmailAddress).join(', ')}\r\n`
      }
      else {
        message += `Bcc: ${formatEmailAddress(options.bcc)}\r\n`
      }
    }

    // Add other headers
    message += `Subject: ${options.subject}\r\n`
    message += `Date: ${now}\r\n`
    message += `Message-ID: ${messageId}\r\n`
    message += 'MIME-Version: 1.0\r\n'

    // Add custom headers if provided
    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        message += `${name}: ${value}\r\n`
      }
    }

    // Start multipart message
    message += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`

    // Add plain text part if provided
    if (options.text) {
      message += `--${boundary}\r\n`
      message += 'Content-Type: text/plain; charset=UTF-8\r\n'
      message += 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
      message += `${options.text.replace(/([=\r\n])/g, '=$1')}\r\n\r\n`
    }

    // Add HTML part if provided
    if (options.html) {
      message += `--${boundary}\r\n`
      message += 'Content-Type: text/html; charset=UTF-8\r\n'
      message += 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
      message += `${options.html.replace(/([=\r\n])/g, '=$1')}\r\n\r\n`
    }

    // Close the MIME message
    message += `--${boundary}--\r\n`

    return message
  }

  return {
    name: PROVIDER_NAME,
    features: {
      attachments: false, // Not implemented in this version
      html: true,
      templates: false,
      tracking: false,
      customHeaders: true,
      batchSending: false,
      tagging: false, // Explicitly state that tagging is not supported
      scheduling: false, // Explicitly state that scheduling is not supported
      replyTo: false, // Explicitly state that reply-to is not supported
    },
    options,

    /**
     * Initialize the AWS SES provider
     */
    initialize() {
      // Nothing special needed here
      debug('Initializing AWS SES provider with options:', {
        region: options.region,
        accessKeyId: options.accessKeyId ? `***${options.accessKeyId.slice(-4)}` : undefined,
        secretAccessKey: options.secretAccessKey ? '***' : undefined,
        endpoint: options.endpoint,
      })
    },

    /**
     * Check if AWS SES is available
     */
    async isAvailable(): Promise<boolean> {
      try {
        const response = await makeRequest('GetSendQuota', {})
        return !!response.Max24HourSend
      }
      catch {
        return false
      }
    },

    /**
     * Validate AWS SES credentials
     */
    async validateCredentials(): Promise<boolean> {
      return this.isAvailable()
    },

    /**
     * Send email using AWS SES with the Raw Email API
     * This avoids issues with the complex XML structure of the regular SendEmail API
     */
    async sendEmail(options: AwsSesEmailOptions): Promise<Result<EmailResult>> {
      try {
        // Validate email options
        const validationErrors = validateEmailOptions(options)
        if (validationErrors.length > 0) {
          throw createError(PROVIDER_NAME, `Invalid email options: ${validationErrors.join(', ')}`)
        }

        // Prepare AWS SES specific options
        const params: Record<string, any> = {}

        if (options.configurationSetName) {
          params.ConfigurationSetName = options.configurationSetName
        }

        if (options.sourceArn) {
          params.SourceArn = options.sourceArn
        }

        if (options.returnPath) {
          params.ReturnPath = options.returnPath
        }

        if (options.returnPathArn) {
          params.ReturnPathArn = options.returnPathArn
        }

        if (options.messageTags && Object.keys(options.messageTags).length > 0) {
          Object.entries(options.messageTags).forEach(([name, value], index) => {
            params[`Tags.member.${index + 1}.Name`] = name
            params[`Tags.member.${index + 1}.Value`] = value
          })
        }

        // Generate the MIME message
        const rawMessage = generateMimeMessage(options)

        // Base64 encode the raw message
        const encodedMessage = Buffer.from(rawMessage).toString('base64')

        // Add the raw message data
        params['RawMessage.Data'] = encodedMessage

        // Send the raw email
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

    /**
     * Get provider instance - returns null since we don't use AWS SDK
     */
    getInstance: () => null,
  }
})
