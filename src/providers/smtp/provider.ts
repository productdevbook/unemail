import type { EmailResult, Result, SmtpConfig } from 'unemail/types'
import type { ProviderFactory } from '../provider.ts'
import type { SmtpEmailOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { buildMimeMessage, createError, createRequiredError, generateMessageId, isPortAvailable, validateEmailOptions } from 'unemail/utils'
import { defineProvider } from '../provider.ts'

// Constants
const PROVIDER_NAME = 'smtp'
const DEFAULT_PORT = 25
const DEFAULT_SECURE_PORT = 465
const DEFAULT_TIMEOUT = 10000
const DEFAULT_SECURE = false
const DEFAULT_MAX_CONNECTIONS = 5
const DEFAULT_POOL_WAIT_TIMEOUT = 30000

/**
 * SMTP provider for sending emails via SMTP protocol
 */
export const smtpProvider: ProviderFactory<SmtpConfig, any, SmtpEmailOptions> = defineProvider((opts: SmtpConfig = {} as SmtpConfig) => {
  // Validate required options
  if (!opts.host) {
    throw createRequiredError(PROVIDER_NAME, 'host')
  }

  // Initialize with defaults
  const options: Required<Omit<SmtpConfig, 'user' | 'password' | 'oauth2' | 'dkim'>> & Pick<SmtpConfig, 'user' | 'password' | 'oauth2' | 'dkim'> = {
    host: opts.host,
    port: opts.port !== undefined ? opts.port : (opts.secure ? DEFAULT_SECURE_PORT : DEFAULT_PORT),
    secure: opts.secure ?? DEFAULT_SECURE,
    user: opts.user,
    password: opts.password,
    rejectUnauthorized: opts.rejectUnauthorized ?? true,
    pool: opts.pool ?? false,
    maxConnections: opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    authMethod: opts.authMethod || 'LOGIN', // Assign default to avoid undefined
    oauth2: opts.oauth2,
    dkim: opts.dkim,
  }

  // Track connection state
  let isInitialized = false

  // Connection pool management
  const connectionPool: net.Socket[] = []
  const connectionQueue: Array<{
    resolve: (socket: net.Socket) => void
    reject: (error: Error) => void
    timeout?: NodeJS.Timeout
  }> = []

  /**
   * Sanitize header value to prevent injection attacks
   * Removes newlines and other control characters
   */
  const sanitizeHeaderValue = (value: string): string => {
    return value.replace(/[\r\n\t\v\f]/g, ' ').trim()
  }

  /**
   * Parse SMTP server response to check capabilities
   */
  const parseEhloResponse = (response: string): Record<string, string[]> => {
    const lines = response.split('\r\n')
    const capabilities: Record<string, string[]> = {}

    for (const line of lines) {
      if (line.startsWith('250-') || line.startsWith('250 ')) {
        const capLine = line.substring(4).trim()
        const parts = capLine.split(' ')
        const key = parts[0]

        if (key) {
          capabilities[key] = parts.slice(1)
        }
      }
    }

    return capabilities
  }

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
      let lastLineCode = ''

      const onData = (data: Buffer) => {
        responseBuffer += data.toString()
        // SMTP çok satırlı yanıtlar: 250-...\r\n, son satır 250 ...\r\n
        // Her satırı kontrol et
        const lines = responseBuffer.split('\r\n').filter(Boolean)
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1]
          const match = lastLine.match(/^(\d{3})[\s-]/)
          if (match) {
            lastLineCode = match[1]
            // Son satırda boşluk varsa (multi-line bitti)
            if (lastLine[3] === ' ') {
              socket.removeListener('data', onData)
              if (expectedCodes.includes(lastLineCode)) {
                resolve(responseBuffer)
              }
              else {
                reject(createError(PROVIDER_NAME, `Expected ${expectedCodes.join(' or ')}, got ${lastLineCode}: ${responseBuffer.trim()}`))
              }
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
    // If pooling is enabled and there are available connections, use one
    if (options.pool && connectionPool.length > 0) {
      const socket = connectionPool.pop()
      if (socket && !socket.destroyed) {
        return socket
      }
    }

    // If we've reached max connections and pooling is enabled, wait for a connection
    if (options.pool && connectionPool.length + 1 >= options.maxConnections) {
      return new Promise<net.Socket>((resolve, reject) => {
        // Create queue item with explicit timeout property
        const queueItem: {
          resolve: (socket: net.Socket) => void
          reject: (error: Error) => void
          timeout?: NodeJS.Timeout
        } = { resolve, reject }

        // Set a timeout for waiting in the queue
        queueItem.timeout = setTimeout(() => {
          const index = connectionQueue.indexOf(queueItem)
          if (index !== -1) {
            connectionQueue.splice(index, 1)
          }
          reject(createError(PROVIDER_NAME, `Connection queue timeout after ${DEFAULT_POOL_WAIT_TIMEOUT}ms`))
        }, DEFAULT_POOL_WAIT_TIMEOUT)

        connectionQueue.push(queueItem)
      })
    }

    return new Promise<net.Socket>((resolve, reject) => {
      try {
        // Create appropriate socket based on secure option
        const socket = options.secure
          ? tls.connect({
              host: options.host,
              port: options.port,
              rejectUnauthorized: options.rejectUnauthorized,
            })
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
        socket.once('data', (data: Buffer) => {
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
   * Upgrade plain connection to TLS using STARTTLS
   */
  const upgradeToTLS = async (socket: net.Socket): Promise<net.Socket> => {
    return new Promise<net.Socket>((resolve, reject) => {
      try {
        // Create TLS socket options
        const tlsOptions = {
          socket,
          host: options.host,
          rejectUnauthorized: options.rejectUnauthorized,
        }

        // Create TLS connection
        const tlsSocket = tls.connect(tlsOptions)

        // Set timeout
        tlsSocket.setTimeout(DEFAULT_TIMEOUT)

        // Handle TLS connection errors
        tlsSocket.on('error', (err) => {
          reject(createError(PROVIDER_NAME, `TLS connection error: ${err.message}`, { cause: err }))
        })

        // Handle timeout
        tlsSocket.on('timeout', () => {
          tlsSocket.destroy()
          reject(createError(PROVIDER_NAME, 'TLS connection timeout'))
        })

        // Resolve when secure connection is established
        tlsSocket.once('secure', () => {
          resolve(tlsSocket)
        })
      }
      catch (err) {
        reject(createError(PROVIDER_NAME, `Failed to upgrade to TLS: ${(err as Error).message}`, { cause: err as Error }))
      }
    })
  }

  /**
   * Return a connection to the pool or close it
   */
  const releaseConnection = (socket: net.Socket): void => {
    // If the socket is destroyed or pooling is disabled, don't try to reuse it
    if (socket.destroyed || !options.pool) {
      try {
        socket.destroy()
      }
      catch {
        // Ignore destroy errors
      }
      return
    }

    // If there are connections waiting in the queue, give this socket to the next one
    if (connectionQueue.length > 0) {
      const next = connectionQueue.shift()
      if (next) {
        clearTimeout(next.timeout)
        next.resolve(socket)
        return
      }
    }

    // Otherwise add it back to the pool
    connectionPool.push(socket)
  }

  /**
   * Close SMTP connection
   */
  const closeConnection = async (socket: net.Socket, release = false): Promise<void> => {
    return new Promise<void>((resolve) => {
      try {
        if (release) {
          // Reset the connection state by sending RSET command
          socket.write('RSET\r\n')

          // Release the connection back to the pool
          releaseConnection(socket)
          resolve()
          return
        }

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
    if (!options.user) {
      return // No authentication needed
    }

    // Detect auth methods from server response
    const ehloResponse = await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
    const capabilities = parseEhloResponse(ehloResponse)

    // Get supported AUTH methods
    const authCapability = Object.keys(capabilities).find(key => key.toUpperCase() === 'AUTH')
    if (!authCapability && (options.user || options.password)) {
      throw createError(PROVIDER_NAME, 'Server does not support authentication')
    }

    // Add null check before accessing capabilities with authCapability
    const supportedMethods = authCapability ? capabilities[authCapability] || [] : []

    const authMethod = options.authMethod
      || (supportedMethods.includes('CRAM-MD5')
        ? 'CRAM-MD5'
        : supportedMethods.includes('LOGIN')
          ? 'LOGIN'
          : supportedMethods.includes('PLAIN') ? 'PLAIN' : null)

    if (!authMethod) {
      throw createError(PROVIDER_NAME, 'No supported authentication methods')
    }

    // Handle OAUTH2 authentication if configured
    if (authMethod === 'OAUTH2' && options.oauth2) {
      const { user, accessToken } = options.oauth2
      const auth = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`
      const authBase64 = Buffer.from(auth).toString('base64')

      await sendSmtpCommand(socket, `AUTH XOAUTH2 ${authBase64}`, '235')
      return
    }

    // Handle CRAM-MD5 authentication
    if (authMethod === 'CRAM-MD5' && options.password) {
      // Request challenge from server
      const response = await sendSmtpCommand(socket, 'AUTH CRAM-MD5', '334')

      // Decode challenge
      const challenge = Buffer.from(response.split(' ')[1], 'base64').toString('utf-8')

      // Calculate HMAC digest
      const hmac = crypto.createHmac('md5', options.password)
      hmac.update(challenge)
      const digest = hmac.digest('hex')

      // Respond with username and digest
      const cramResponse = `${options.user} ${digest}`
      await sendSmtpCommand(
        socket,
        Buffer.from(cramResponse).toString('base64'),
        '235',
      )
      return
    }

    // Handle LOGIN authentication
    if (authMethod === 'LOGIN' && options.password) {
      // Send AUTH command
      await sendSmtpCommand(socket, 'AUTH LOGIN', '334')

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
      return
    }

    // Handle PLAIN authentication (fallback)
    if (authMethod === 'PLAIN' && options.password) {
      // Send AUTH PLAIN command with credentials
      const authPlain = Buffer.from(`\0${options.user}\0${options.password}`).toString('base64')
      await sendSmtpCommand(
        socket,
        `AUTH PLAIN ${authPlain}`,
        '235',
      )
      return
    }

    throw createError(PROVIDER_NAME, 'Authentication failed - no valid credentials or method')
  }

  /**
   * Sign email with DKIM
   */
  const signWithDkim = (message: string): string => {
    if (!options.dkim) {
      return message
    }

    const { domainName, keySelector, privateKey } = options.dkim

    try {
      // Parse the message to separate headers and body
      const [headersPart, bodyPart] = message.split('\r\n\r\n')
      const headers = headersPart.split('\r\n')

      // DKIM canonicalization (relaxed/relaxed, basic)
      const canonicalize = (str: string) => str.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
      const canonicalizedBody = canonicalize(bodyPart)
      const bodyHash = crypto.createHash('sha256').update(canonicalizedBody).digest('base64')

      // Find which headers to sign (from, to, subject, date)
      const headerNames = ['from', 'to', 'subject', 'date']
      const headersToSign = headers.filter(h => headerNames.some(n => h.toLowerCase().startsWith(`${n}:`)))
      const dkimHeaderList = headersToSign.map(h => h.split(':')[0].toLowerCase()).join(':')

      // Build DKIM header (without signature)
      const now = Math.floor(Date.now() / 1000)
      const dkimFields = {
        v: '1',
        a: 'rsa-sha256',
        c: 'relaxed/relaxed',
        d: domainName,
        s: keySelector,
        t: now.toString(),
        bh: bodyHash,
        h: dkimHeaderList,
      }
      const dkimHeader = `DKIM-Signature: ${Object.entries(dkimFields).map(([k, v]) => `${k}=${v}`).join('; ')}; b=`

      // Canonicalize headers for signing
      const headersForSign = [...headersToSign, dkimHeader].map(canonicalize).join('\r\n')
      const signer = crypto.createSign('RSA-SHA256')
      signer.update(headersForSign)
      const signature = signer.sign(privateKey, 'base64')
      const finalDkimHeader = `${dkimHeader}${signature}`

      // DKIM-Signature en başa eklenmeli
      return `${finalDkimHeader}\r\n${headers.join('\r\n')}\r\n\r\n${bodyPart}`
    }
    catch (error) {
      console.error(`[${PROVIDER_NAME}] DKIM signing error:`, error)
      return message
    }
  }

  return {
    name: PROVIDER_NAME,
    features: {
      attachments: true,
      html: true,
      templates: false,
      tracking: false,
      customHeaders: true,
      batchSending: options.pool, // Now supported with pooling
      tagging: false,
      scheduling: false,
      replyTo: true,
    },
    options,

    /**
     * Initialize the SMTP provider
     */
    async initialize(): Promise<void> {
      // Check if the provider is already initialized
      if (isInitialized) {
        return
      }

      try {
        // Check if SMTP server is available
        if (!await this.isAvailable()) {
          throw createError(
            PROVIDER_NAME,
            `SMTP server not available at ${options.host}:${options.port}`,
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
     * Check if SMTP server is available
     */
    async isAvailable(): Promise<boolean> {
      try {
        // First check if port is open
        const portAvailable = await isPortAvailable(options.host, options.port)

        if (!portAvailable) {
          return false
        }

        // Then try establishing a connection
        const socket = await createSmtpConnection()
        await closeConnection(socket)

        return true
      }
      catch {
        return false
      }
    },

    /**
     * Send email through SMTP
     */
    async sendEmail(emailOpts: SmtpEmailOptions): Promise<Result<EmailResult>> {
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
        let socket = await createSmtpConnection()

        try {
          // EHLO handshake
          await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')

          // Support for STARTTLS (if not already using TLS and server supports it)
          if (!options.secure) {
            try {
              const ehloResponse = await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              const capabilities = parseEhloResponse(ehloResponse)

              if (Object.keys(capabilities).includes('STARTTLS')) {
                // Server supports STARTTLS, so use it
                await sendSmtpCommand(socket, 'STARTTLS', '220')

                // Upgrade connection to TLS
                const tlsSocket = await upgradeToTLS(socket)

                // Replace socket reference with secure version
                socket = tlsSocket

                // Re-issue EHLO command over secured connection
                await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              }
            }
            catch (error) {
              // STARTTLS not supported or failed, continue with plain connection
              if (options.rejectUnauthorized !== false) {
                throw createError(
                  PROVIDER_NAME,
                  `STARTTLS failed or not supported: ${(error as Error).message}`,
                  { cause: error as Error },
                )
              }
            }
          }

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
          let mimeMessage = buildMimeMessage(emailOpts)

          // Add special headers based on email options
          const additionalHeaders: string[] = []

          // Add DSN headers if requested
          if (emailOpts.dsn) {
            const dsnOptions = []
            if (emailOpts.dsn.success)
              dsnOptions.push('SUCCESS')
            if (emailOpts.dsn.failure)
              dsnOptions.push('FAILURE')
            if (emailOpts.dsn.delay)
              dsnOptions.push('DELAY')

            if (dsnOptions.length > 0) {
              additionalHeaders.push(`X-DSN-NOTIFY: ${dsnOptions.join(',')}`)
            }
          }

          // Add priority if specified
          if (emailOpts.priority) {
            let priorityValue = ''
            switch (emailOpts.priority) {
              case 'high':
                priorityValue = '1 (Highest)'
                additionalHeaders.push('Importance: High')
                break
              case 'normal':
                priorityValue = '3 (Normal)'
                additionalHeaders.push('Importance: Normal')
                break
              case 'low':
                priorityValue = '5 (Lowest)'
                additionalHeaders.push('Importance: Low')
                break
            }
            additionalHeaders.push(`X-Priority: ${priorityValue}`)
          }

          // Add In-Reply-To header if specified
          if (emailOpts.inReplyTo) {
            additionalHeaders.push(`In-Reply-To: ${sanitizeHeaderValue(emailOpts.inReplyTo)}`)
          }

          // Add References header if specified
          if (emailOpts.references) {
            const refs = Array.isArray(emailOpts.references)
              ? emailOpts.references.map(sanitizeHeaderValue).join(' ')
              : sanitizeHeaderValue(emailOpts.references)

            additionalHeaders.push(`References: ${refs}`)
          }

          // Add List-Unsubscribe header if specified
          if (emailOpts.listUnsubscribe) {
            let unsubValue
            if (Array.isArray(emailOpts.listUnsubscribe)) {
              unsubValue = emailOpts.listUnsubscribe
                .map(val => `<${sanitizeHeaderValue(val)}>`)
                .join(', ')
            }
            else {
              unsubValue = `<${sanitizeHeaderValue(emailOpts.listUnsubscribe)}>`
            }

            additionalHeaders.push(`List-Unsubscribe: ${unsubValue}`)
          }

          // Add Google Mail specific headers
          if (emailOpts.googleMailHeaders) {
            const { googleMailHeaders } = emailOpts

            // Add Feedback ID
            if (googleMailHeaders.feedbackId) {
              additionalHeaders.push(
                `Feedback-ID: ${sanitizeHeaderValue(googleMailHeaders.feedbackId)}`,
              )
            }

            // Add promotional content indicator
            if (googleMailHeaders.promotionalContent) {
              additionalHeaders.push('X-Google-Promotion: promotional')
            }

            // Add category
            if (googleMailHeaders.category) {
              additionalHeaders.push(`X-Gmail-Labels: ${googleMailHeaders.category}`)
            }
          }

          // Insert additional headers at the top of the message
          if (additionalHeaders.length > 0) {
            const splitIndex = mimeMessage.indexOf('\r\n\r\n')
            if (splitIndex !== -1) {
              const headerPart = mimeMessage.slice(0, splitIndex)
              const bodyPart = mimeMessage.slice(splitIndex + 4)
              mimeMessage = `${headerPart}\r\n${additionalHeaders.join('\r\n')}\r\n\r\n${bodyPart}`
            }
          }

          // Apply DKIM signing if configured and requested
          if (options.dkim && (emailOpts.useDkim || emailOpts.useDkim === undefined)) {
            mimeMessage = signWithDkim(mimeMessage)
          }

          // Send message content and finish with .
          await sendSmtpCommand(socket, `${mimeMessage}\r\n.`, '250')

          // Generate message ID if not present in response
          const messageId = generateMessageId()

          // Return connection to pool or close it
          await closeConnection(socket, options.pool)

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
     * Validate SMTP credentials
     */
    async validateCredentials(): Promise<boolean> {
      try {
        if (!await this.isAvailable()) {
          return false
        }

        // Create connection and try to authenticate
        const socket = await createSmtpConnection()

        try {
          // EHLO handshake
          await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')

          // Try STARTTLS if not using secure connection directly
          if (!options.secure) {
            try {
              const ehloResponse = await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              const capabilities = parseEhloResponse(ehloResponse)

              if (Object.keys(capabilities).includes('STARTTLS')) {
                // Server supports STARTTLS, so use it
                await sendSmtpCommand(socket, 'STARTTLS', '220')

                // Upgrade connection to TLS
                const tlsSocket = await upgradeToTLS(socket)

                // Replace socket with secure version
                Object.assign(socket, tlsSocket)

                // Re-issue EHLO command over secured connection
                await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              }
            }
            catch {
              // STARTTLS not supported or failed, continue with plain connection
              if (options.rejectUnauthorized !== false) {
                return false
              }
            }
          }

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

    /**
     * Cleanly shut down the provider and release resources
     */
    async shutdown(): Promise<void> {
      // Close all connections in the pool
      for (const socket of connectionPool) {
        try {
          await closeConnection(socket)
        }
        catch {
          // Ignore errors during shutdown
        }
      }

      // Clear the connection pool
      connectionPool.length = 0

      // Reject any waiting connections
      for (const queueItem of connectionQueue) {
        clearTimeout(queueItem.timeout)
        queueItem.reject(new Error('Provider shutdown'))
      }

      // Clear the connection queue
      connectionQueue.length = 0
    },
  }
})
