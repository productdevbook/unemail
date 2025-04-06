import type { EmailResult, MailCrabConfig, Result } from 'unemail/types'
import type { ProviderFactory } from '../provider.ts'
import type { MailCrabEmailOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { buildMimeMessage, createError, generateMessageId, isPortAvailable, validateEmailOptions } from 'unemail/utils'
import { defineProvider } from '../provider.ts'

// Constants
const PROVIDER_NAME = 'mailcrab'
const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 1025
const DEFAULT_TIMEOUT = 5000
const DEFAULT_SECURE = false

/**
 * MailCrab provider for sending emails directly using SMTP
 */
export const mailcrabProvider: ProviderFactory<MailCrabConfig, any, MailCrabEmailOptions> = defineProvider((opts: MailCrabConfig = {}) => {
  // Initialize with defaults
  const options: Required<MailCrabConfig> = {
    host: opts.host || DEFAULT_HOST,
    port: opts.port || DEFAULT_PORT,
    secure: opts.secure ?? DEFAULT_SECURE,
    user: opts.user || '',
    password: opts.password || '',
  }

  // Track connection state
  let isInitialized = false

  /**
   * Send SMTP command and await response
   */
  const sendSmtpCommand = async (
    socket: net.Socket,
    command: string,
    expectedCode: string | string[],
  ): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const expectedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode]
      let responseBuffer = ''

      const onData = (data: Buffer) => {
        responseBuffer += data.toString()

        // Check if we have a complete SMTP response
        const lines = responseBuffer.split('\r\n')
        if (lines.length > 1) {
          const lastLine = lines[lines.length - 2] // Last non-empty line

          if (lastLine && lastLine.length >= 3) {
            const responseCode = lastLine.substring(0, 3)

            if (expectedCodes.includes(responseCode)) {
              socket.removeListener('data', onData)
              resolve(responseBuffer)
            }
            else {
              socket.removeListener('data', onData)
              reject(createError(PROVIDER_NAME, `Expected ${expectedCodes.join(' or ')}, got ${responseCode}: ${lastLine.substring(4)}`))
            }
          }
        }
      }

      socket.on('data', onData)

      if (command) {
        socket.write(`${command}\r\n`)
      }
    })
  }

  /**
   * Create SMTP connection
   */
  const createSmtpConnection = async (): Promise<net.Socket> => {
    return new Promise<net.Socket>((resolve, reject) => {
      try {
        // Create appropriate socket based on secure option
        const socket = options.secure
          ? tls.connect(options.port, options.host, { rejectUnauthorized: false })
          : net.createConnection(options.port, options.host)

        // Set timeout
        socket.setTimeout(DEFAULT_TIMEOUT)

        // Handle connection timeout
        socket.on('timeout', () => {
          socket.destroy()
          reject(createError(PROVIDER_NAME, `Connection timeout to ${options.host}:${options.port}`))
        })

        // Handle errors
        socket.on('error', (err) => {
          reject(createError(PROVIDER_NAME, `Connection error: ${err.message}`, { cause: err }))
        })

        // Wait for connection and server greeting
        socket.once('data', (data) => {
          const greeting = data.toString()
          const code = greeting.substring(0, 3)

          if (code === '220') {
            resolve(socket)
          }
          else {
            socket.destroy()
            reject(createError(PROVIDER_NAME, `Unexpected server greeting: ${greeting.trim()}`))
          }
        })
      }
      catch (err) {
        reject(createError(PROVIDER_NAME, `Failed to create connection: ${(err as Error).message}`, { cause: err as Error }))
      }
    })
  }

  /**
   * Close SMTP connection
   */
  const closeConnection = async (socket: net.Socket): Promise<void> => {
    return new Promise<void>((resolve) => {
      try {
        // Send QUIT command
        socket.write('QUIT\r\n')
        socket.end()
        socket.once('close', () => resolve())
      }
      catch {
        // Just resolve even if there's an error during close
        resolve()
      }
    })
  }

  /**
   * Perform SMTP authentication
   */
  const authenticate = async (socket: net.Socket): Promise<void> => {
    if (!options.user || !options.password) {
      return // No authentication needed
    }

    // Send AUTH command
    await sendSmtpCommand(
      socket,
      'AUTH LOGIN',
      '334',
    )

    // Send username (base64 encoded)
    await sendSmtpCommand(
      socket,
      Buffer.from(options.user).toString('base64'),
      '334',
    )

    // Send password (base64 encoded)
    await sendSmtpCommand(
      socket,
      Buffer.from(options.password).toString('base64'),
      '235',
    )
  }

  return {
    name: PROVIDER_NAME,
    features: {
      attachments: true,
      html: true,
      templates: false,
      tracking: false,
      customHeaders: true,
      batchSending: false,
      tagging: false, // Explicitly state that tagging is not supported
      scheduling: false, // Explicitly state that scheduling is not supported
      replyTo: true, // MailCrab supports reply-to headers
    },
    options,

    /**
     * Initialize the MailCrab provider
     */
    async initialize(): Promise<void> {
      // Check if the provider is already initialized
      if (isInitialized) {
        return
      }

      try {
        // Check if MailCrab is available
        if (!await this.isAvailable()) {
          throw createError(
            PROVIDER_NAME,
            `MailCrab server not available at ${options.host}:${options.port}`,
          )
        }

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

    /**
     * Check if MailCrab server is available
     */
    async isAvailable(): Promise<boolean> {
      return isPortAvailable(options.host, options.port)
    },

    /**
     * Send email through MailCrab SMTP
     */
    async sendEmail(emailOpts: MailCrabEmailOptions): Promise<Result<EmailResult>> {
      try {
        // Validate email options
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

        // Make sure provider is initialized
        if (!isInitialized) {
          await this.initialize()
        }

        // Create SMTP connection
        const socket = await createSmtpConnection()

        try {
          // EHLO handshake
          await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')

          // Authenticate if credentials are provided
          await authenticate(socket)

          // MAIL FROM command
          await sendSmtpCommand(
            socket,
            `MAIL FROM:<${emailOpts.from.email}>`,
            '250',
          )

          // RCPT TO commands (including CC and BCC)
          const recipients: string[] = []

          // Add primary recipients
          if (Array.isArray(emailOpts.to)) {
            recipients.push(...emailOpts.to.map(r => r.email))
          }
          else {
            recipients.push(emailOpts.to.email)
          }

          // Add CC recipients
          if (emailOpts.cc) {
            if (Array.isArray(emailOpts.cc)) {
              recipients.push(...emailOpts.cc.map(r => r.email))
            }
            else {
              recipients.push(emailOpts.cc.email)
            }
          }

          // Add BCC recipients
          if (emailOpts.bcc) {
            if (Array.isArray(emailOpts.bcc)) {
              recipients.push(...emailOpts.bcc.map(r => r.email))
            }
            else {
              recipients.push(emailOpts.bcc.email)
            }
          }

          // Send RCPT TO for each recipient
          for (const recipient of recipients) {
            await sendSmtpCommand(
              socket,
              `RCPT TO:<${recipient}>`,
              '250',
            )
          }

          // DATA command
          await sendSmtpCommand(socket, 'DATA', '354')

          // Build and send MIME message
          const mimeMessage = buildMimeMessage(emailOpts)

          // Send message content and finish with .
          await sendSmtpCommand(socket, `${mimeMessage}\r\n.`, '250')

          // Generate message ID if not present in response
          const messageId = generateMessageId()

          // Close the connection
          await closeConnection(socket)

          return {
            success: true,
            data: {
              messageId,
              sent: true,
              timestamp: new Date(),
              provider: PROVIDER_NAME,
              response: 'Message accepted',
            },
          }
        }
        catch (error) {
          // Make sure connection is closed on error
          try {
            await closeConnection(socket)
          }
          catch {
            // Ignore close errors
          }

          throw error
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

    /**
     * Validate MailCrab credentials
     */
    async validateCredentials(): Promise<boolean> {
      try {
        if (!await this.isAvailable()) {
          return false
        }

        // No credentials to validate for MailCrab in development mode
        if (!options.user || !options.password) {
          return true
        }

        // Create connection and try to authenticate
        const socket = await createSmtpConnection()

        try {
          // EHLO handshake
          await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')

          // Try authentication
          await authenticate(socket)

          // Close connection
          await closeConnection(socket)

          return true
        }
        catch {
          await closeConnection(socket)
          return false
        }
      }
      catch {
        return false
      }
    },
  }
})
