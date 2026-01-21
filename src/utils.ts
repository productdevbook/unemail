import type { Attachment, EmailAddress, EmailOptions, ErrorOptions, Result } from './types.ts'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import { URL } from 'node:url'

/**
 * Creates a formatted error message
 *
 * @param component The component where the error occurred
 * @param message Error message
 * @param opts Additional error options
 * @returns Error object
 */
export function createError(
  component: string,
  message: string,
  opts?: ErrorOptions,
): Error {
  const err = new Error(`[unemail] [${component}] ${message}`, opts)
  if (Error.captureStackTrace) {
    Error.captureStackTrace(err, createError)
  }
  return err
}

/**
 * Creates an error for missing required options
 *
 * @param component The component where the error occurred
 * @param name Name of the missing option(s)
 * @returns Error object
 */
export function createRequiredError(component: string, name: string | string[]): Error {
  if (Array.isArray(name)) {
    return createError(
      component,
      `Missing required options: ${name.map(n => `'${n}'`).join(', ')}`,
    )
  }
  return createError(component, `Missing required option: '${name}'`)
}

/**
 * Generates a random message ID for emails
 *
 * @returns A unique message ID
 */
export function generateMessageId(): string {
  const domain = 'unemail.local'
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 10)
  return `<${timestamp}.${random}@${domain}>`
}

/**
 * Makes an HTTP request without external dependencies
 *
 * @param url The URL to make the request to
 * @param options Request options
 * @param data Optional data to send with the request
 * @returns Promise with the response data
 */
export async function makeRequest(
  url: string | URL,
  options: http.RequestOptions = {},
  data?: string | Buffer,
): Promise<Result<any>> {
  return new Promise((resolve) => {
    const urlObj = typeof url === 'string' ? new URL(url) : url
    const protocol = urlObj.protocol === 'https:' ? https : http

    const req = protocol.request(urlObj, options, (res) => {
      const chunks: Buffer[] = []

      res.on('data', chunk => chunks.push(chunk))

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        let parsedBody: any = body

        // Try to parse as JSON if the content-type is json
        if (res.headers['content-type']?.includes('application/json')) {
          try {
            parsedBody = JSON.parse(body)
          }
          catch {
            // If it fails, keep the raw body
          }
        }

        const isSuccess = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300

        resolve({
          success: isSuccess,
          data: {
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsedBody,
          },
          error: isSuccess
            ? undefined
            : createError(
                'http',
                `Request failed with status ${res.statusCode}`,
                { code: res.statusCode?.toString() },
              ),
        })
      })
    })

    req.on('error', (error) => {
      resolve({
        success: false,
        error: createError('http', `Request failed: ${error.message}`, { cause: error }),
      })
    })

    if (options.timeout) {
      req.setTimeout(options.timeout, () => {
        req.destroy(createError('http', `Request timed out after ${options.timeout}ms`))
      })
    }

    if (data) {
      req.write(data)
    }

    req.end()
  })
}

/**
 * Encodes email content for SMTP API
 *
 * @param content The string to encode
 * @returns Base64 encoded string
 */
export function encodeBase64(content: string | Buffer): string {
  return Buffer.from(typeof content === 'string' ? content : content.toString()).toString('base64')
}

/**
 * Helper function to wrap any value in a promise
 *
 * @param value Any value or promise
 * @returns Promise resolving to the value
 */
export function wrapPromise<T>(value: T | Promise<T>): Promise<T> {
  return value instanceof Promise ? value : Promise.resolve(value)
}

/**
 * Helper function to retry a function with exponential backoff
 *
 * @param fn Function to retry
 * @param retries Number of retries
 * @param delay Initial delay in ms
 * @returns Promise with the function result
 */
export async function retry<T>(
  fn: () => Promise<Result<T>>,
  retries: number = 3,
  delay: number = 300,
): Promise<Result<T>> {
  try {
    const result = await fn()
    if (result.success || retries <= 0) {
      return result
    }

    await new Promise(resolve => setTimeout(resolve, delay))
    return retry(fn, retries - 1, delay * 2)
  }
  catch (error) {
    if (retries <= 0) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }

    await new Promise(resolve => setTimeout(resolve, delay))
    return retry(fn, retries - 1, delay * 2)
  }
}

/**
 * Validate email address format
 * @param email Email address to validate
 * @returns Boolean indicating if the email is valid
 */
export function validateEmail(email: string): boolean {
  // Simple regex for email validation
  const emailRegex = /^[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i
  return emailRegex.test(email)
}

/**
 * Format email address as "Name <email@example.com>"
 * @param address Email address object
 * @returns Formatted email string
 */
export function formatEmailAddress(address: EmailAddress): string {
  if (!validateEmail(address.email)) {
    throw createError('email', `Invalid email address: ${address.email}`)
  }

  return address.name
    ? `${address.name} <${address.email}>`
    : address.email
}

/**
 * Format email addresses list
 * @param addresses Single address or array of addresses
 * @returns Comma-separated string of formatted addresses
 */
export function formatEmailAddresses(addresses: EmailAddress | EmailAddress[]): string {
  if (Array.isArray(addresses)) {
    return addresses.map(formatEmailAddress).join(', ')
  }
  return formatEmailAddress(addresses)
}

/**
 * Generate boundary string for multipart emails
 * @returns Random boundary string
 */
export function generateBoundary(): string {
  return `----_=_NextPart_${crypto.randomBytes(16).toString('hex')}`
}

/**
 * Check if a port is available
 * @param host Host to check
 * @param port Port to check
 * @returns Promise resolving to boolean indicating if port is available
 */
export async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()

    const onError = () => {
      socket.destroy()
      resolve(false)
    }

    socket.setTimeout(1000)
    socket.on('error', onError)
    socket.on('timeout', onError)

    socket.connect(port, host, () => {
      socket.end()
      resolve(true)
    })
  })
}

/**
 * Validate email options
 * @param options Email options to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateEmailOptions<T extends EmailOptions>(options: T): string[] {
  const errors: string[] = []

  if (!options.from || !options.from.email) {
    errors.push('Missing required field: from')
  }

  if (!options.to) {
    errors.push('Missing required field: to')
  }

  if (!options.subject) {
    errors.push('Missing required field: subject')
  }

  if (!options.text && !options.html) {
    errors.push('Either text or html content is required')
  }

  // Validate email addresses
  if (options.from && options.from.email && !validateEmail(options.from.email)) {
    errors.push(`Invalid from email address: ${options.from.email}`)
  }

  const checkAddresses = (addresses: EmailAddress | EmailAddress[] | undefined, field: string) => {
    if (!addresses)
      return

    const list = Array.isArray(addresses) ? addresses : [addresses]
    list.forEach((addr) => {
      if (!validateEmail(addr.email)) {
        errors.push(`Invalid ${field} email address: ${addr.email}`)
      }
    })
  }

  checkAddresses(options.to, 'to')
  checkAddresses(options.cc, 'cc')
  checkAddresses(options.bcc, 'bcc')

  // Validate replyTo if present
  if (options.replyTo && !validateEmail(options.replyTo.email)) {
    errors.push(`Invalid replyTo email address: ${options.replyTo.email}`)
  }

  return errors
}

/**
 * Build a MIME message from email options
 * @param options Email options
 * @returns MIME message as string
 */
export function buildMimeMessage<T extends EmailOptions>(options: T): string {
  const boundary = generateBoundary()
  const message: string[] = []

  // Headers
  message.push(`From: ${formatEmailAddress(options.from)}`)
  message.push(`To: ${formatEmailAddresses(options.to)}`)

  if (options.cc) {
    message.push(`Cc: ${formatEmailAddresses(options.cc)}`)
  }

  // Add BCC if present (it won't be visible in the message, but some APIs need it)
  if (options.bcc) {
    message.push(`Bcc: ${formatEmailAddresses(options.bcc)}`)
  }

  // Add Reply-To if present
  if (options.replyTo) {
    message.push(`Reply-To: ${formatEmailAddress(options.replyTo)}`)
  }

  message.push(`Subject: ${options.subject}`)
  message.push('MIME-Version: 1.0')

  // Custom headers
  if (options.headers) {
    Object.entries(options.headers).forEach(([key, value]) => {
      message.push(`${key}: ${value}`)
    })
  }

  // Content-Type with boundary
  message.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
  message.push('')

  // Text part
  if (options.text) {
    message.push(`--${boundary}`)
    message.push('Content-Type: text/plain; charset=UTF-8')
    message.push('Content-Transfer-Encoding: 7bit')
    message.push('')
    message.push(options.text)
    message.push('')
  }

  // HTML part
  if (options.html) {
    message.push(`--${boundary}`)
    message.push('Content-Type: text/html; charset=UTF-8')
    message.push('Content-Transfer-Encoding: 7bit')
    message.push('')
    message.push(options.html)
    message.push('')
  }

  // Attachments
  if (options.attachments && options.attachments.length > 0) {
    options.attachments.forEach((attachment: Attachment) => {
      message.push(`--${boundary}`)

      const contentType = attachment.contentType || 'application/octet-stream'
      const disposition = attachment.disposition || 'attachment'

      message.push(`Content-Type: ${contentType}; name="${attachment.filename}"`)
      message.push('Content-Transfer-Encoding: base64')
      message.push(`Content-Disposition: ${disposition}; filename="${attachment.filename}"`)

      if (attachment.cid) {
        message.push(`Content-ID: <${attachment.cid}>`)
      }

      message.push('')

      // Convert content to base64 if it's not already
      const content = typeof attachment.content === 'string'
        ? Buffer.from(attachment.content).toString('base64')
        : attachment.content.toString('base64')

      // Split base64 content into lines of 76 characters
      const contentChunks: string[] = []
      for (let i = 0; i < content.length; i += 76) {
        contentChunks.push(content.substring(i, i + 76))
      }

      message.push(contentChunks.join('\r\n'))
      message.push('')
    })
  }

  // End boundary
  message.push(`--${boundary}--`)

  return message.join('\r\n')
}
