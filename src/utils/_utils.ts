import type { Attachment, EmailAddress, EmailOptions } from 'unemail/types'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import * as net from 'node:net'
import { createError } from './utils.ts'
/**
 * Internal utilities for email operations
 */

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
      const contentChunks = []
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
