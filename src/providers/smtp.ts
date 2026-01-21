import type { EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { buildMimeMessage, createError, createRequiredError, generateMessageId, isPortAvailable, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types
// ============================================================================

export interface SmtpOptions {
  host: string
  port: number
  secure?: boolean
  user?: string
  password?: string
  rejectUnauthorized?: boolean
  pool?: boolean
  maxConnections?: number
  timeout?: number
  dkim?: {
    domainName: string
    keySelector: string
    privateKey: string
  }
  authMethod?: 'LOGIN' | 'PLAIN' | 'CRAM-MD5' | 'OAUTH2'
  oauth2?: {
    user: string
    clientId: string
    clientSecret: string
    refreshToken: string
    accessToken?: string
    expires?: number
  }
}

export interface SmtpEmailOptions extends EmailOptions {
  dsn?: {
    success?: boolean
    failure?: boolean
    delay?: boolean
  }
  priority?: 'high' | 'normal' | 'low'
  inReplyTo?: string
  references?: string | string[]
  listUnsubscribe?: string | string[]
  googleMailHeaders?: {
    promotionalContent?: boolean
    feedbackId?: string
    category?: 'primary' | 'social' | 'promotions' | 'updates' | 'forums'
  }
  useDkim?: boolean
}

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = 'smtp'
const DEFAULT_PORT = 25
const DEFAULT_SECURE_PORT = 465
const DEFAULT_TIMEOUT = 10000
const DEFAULT_SECURE = false
const DEFAULT_MAX_CONNECTIONS = 5
const DEFAULT_POOL_WAIT_TIMEOUT = 30000

// ============================================================================
// Provider Implementation
// ============================================================================

export const smtpProvider: ProviderFactory<SmtpOptions, any, SmtpEmailOptions> = defineProvider((opts: SmtpOptions = {} as SmtpOptions) => {
  if (!opts.host) {
    throw createRequiredError(PROVIDER_NAME, 'host')
  }

  const options: Required<Omit<SmtpOptions, 'user' | 'password' | 'oauth2' | 'dkim'>> & Pick<SmtpOptions, 'user' | 'password' | 'oauth2' | 'dkim'> = {
    host: opts.host,
    port: opts.port !== undefined ? opts.port : (opts.secure ? DEFAULT_SECURE_PORT : DEFAULT_PORT),
    secure: opts.secure ?? DEFAULT_SECURE,
    user: opts.user,
    password: opts.password,
    rejectUnauthorized: opts.rejectUnauthorized ?? true,
    pool: opts.pool ?? false,
    maxConnections: opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    authMethod: opts.authMethod || 'LOGIN',
    oauth2: opts.oauth2,
    dkim: opts.dkim,
  }

  let isInitialized = false

  const connectionPool: net.Socket[] = []
  const connectionQueue: Array<{
    resolve: (socket: net.Socket) => void
    reject: (error: Error) => void
    timeout?: NodeJS.Timeout
  }> = []

  const sanitizeHeaderValue = (value: string): string => {
    return value.replace(/[\r\n\t\v\f]/g, ' ').trim()
  }

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

  const sendSmtpCommand = async (
    socket: net.Socket,
    command: string,
    expectedCode: string | string[],
  ): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const expectedCodes = Array.isArray(expectedCode) ? expectedCode : [expectedCode]
      let responseBuffer = ''
      let lastLineCode = ''
      let timeoutHandle: NodeJS.Timeout

      let onData: (data: Buffer) => void
      let onError: (err: Error) => void

      const cleanup = () => {
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
        if (timeoutHandle) {
          clearTimeout(timeoutHandle)
        }
      }

      onError = (err: Error) => {
        cleanup()
        reject(createError(PROVIDER_NAME, `Socket error: ${err.message}`, { cause: err }))
      }

      onData = (data: Buffer) => {
        responseBuffer += data.toString()
        const lines = responseBuffer.split('\r\n').filter(Boolean)
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1]
          if (lastLine) {
            const match = lastLine.match(/^(\d{3})[\s-]/)
            if (match && match[1]) {
              lastLineCode = match[1]
              if (lastLine[3] === ' ') {
                cleanup()
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
      }

      timeoutHandle = setTimeout(() => {
        cleanup()
        reject(createError(PROVIDER_NAME, `Command timeout after ${options.timeout}ms: ${command?.substring(0, 50)}...`))
      }, options.timeout)

      socket.on('data', onData)
      socket.on('error', onError)

      if (command) {
        socket.write(`${command}\r\n`)
      }
    })
  }

  const createSmtpConnection = async (): Promise<net.Socket> => {
    if (options.pool && connectionPool.length > 0) {
      const socket = connectionPool.pop()
      if (socket && !socket.destroyed) {
        return socket
      }
    }

    if (options.pool && connectionPool.length + 1 >= options.maxConnections) {
      return new Promise<net.Socket>((resolve, reject) => {
        const queueItem: {
          resolve: (socket: net.Socket) => void
          reject: (error: Error) => void
          timeout?: NodeJS.Timeout
        } = { resolve, reject }

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
        const socket = options.secure
          ? tls.connect({
              host: options.host,
              port: options.port,
              rejectUnauthorized: options.rejectUnauthorized,
            })
          : net.createConnection(options.port, options.host)

        socket.setTimeout(options.timeout)

        socket.on('timeout', () => {
          socket.destroy()
          reject(createError(PROVIDER_NAME, `Connection timeout to ${options.host}:${options.port} after ${options.timeout}ms`))
        })

        socket.on('error', (err) => {
          reject(createError(PROVIDER_NAME, `Connection error: ${err.message}`, { cause: err }))
        })

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

  const upgradeToTLS = async (socket: net.Socket): Promise<net.Socket> => {
    return new Promise<net.Socket>((resolve, reject) => {
      try {
        const tlsOptions = {
          socket,
          host: options.host,
          rejectUnauthorized: options.rejectUnauthorized,
        }

        const tlsSocket = tls.connect(tlsOptions)

        tlsSocket.setTimeout(options.timeout)

        tlsSocket.on('error', (err) => {
          reject(createError(PROVIDER_NAME, `TLS connection error: ${err.message}`, { cause: err }))
        })

        tlsSocket.on('timeout', () => {
          tlsSocket.destroy()
          reject(createError(PROVIDER_NAME, `TLS connection timeout after ${options.timeout}ms`))
        })

        tlsSocket.once('secure', () => {
          resolve(tlsSocket)
        })
      }
      catch (err) {
        reject(createError(PROVIDER_NAME, `Failed to upgrade to TLS: ${(err as Error).message}`, { cause: err as Error }))
      }
    })
  }

  const releaseConnection = (socket: net.Socket): void => {
    if (socket.destroyed || !options.pool) {
      try {
        socket.destroy()
      }
      catch {
        // Ignore destroy errors
      }
      return
    }

    if (connectionQueue.length > 0) {
      const next = connectionQueue.shift()
      if (next) {
        clearTimeout(next.timeout)
        next.resolve(socket)
        return
      }
    }

    connectionPool.push(socket)
  }

  const closeConnection = async (socket: net.Socket, release = false): Promise<void> => {
    return new Promise<void>((resolve) => {
      try {
        if (release) {
          socket.write('RSET\r\n')
          releaseConnection(socket)
          resolve()
          return
        }

        socket.write('QUIT\r\n')
        socket.end()
        socket.once('close', () => resolve())
      }
      catch {
        resolve()
      }
    })
  }

  const authenticate = async (socket: net.Socket): Promise<void> => {
    if (!options.user) {
      return
    }

    const ehloResponse = await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
    const capabilities = parseEhloResponse(ehloResponse)

    const authCapability = Object.keys(capabilities).find(key => key.toUpperCase() === 'AUTH')
    if (!authCapability && (options.user || options.password)) {
      throw createError(PROVIDER_NAME, 'Server does not support authentication')
    }

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

    if (authMethod === 'OAUTH2' && options.oauth2) {
      try {
        const { user, accessToken } = options.oauth2
        const auth = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`
        const authBase64 = Buffer.from(auth).toString('base64')

        await sendSmtpCommand(socket, `AUTH XOAUTH2 ${authBase64}`, '235')
        return
      }
      catch (error) {
        const errorMessage = (error as Error).message
        if (errorMessage.includes('535') || errorMessage.includes('Authentication failed')) {
          throw createError(PROVIDER_NAME, 'Authentication failed: Invalid OAuth2 credentials')
        }
        throw error
      }
    }

    if (authMethod === 'CRAM-MD5' && options.password) {
      try {
        const response = await sendSmtpCommand(socket, 'AUTH CRAM-MD5', '334')

        const challengePart = response.split(' ')[1]
        if (!challengePart) {
          throw createError(PROVIDER_NAME, 'Invalid CRAM-MD5 challenge response')
        }
        const challenge = Buffer.from(challengePart, 'base64').toString('utf-8')

        const hmac = crypto.createHmac('md5', options.password)
        hmac.update(challenge)
        const digest = hmac.digest('hex')

        const cramResponse = `${options.user} ${digest}`
        await sendSmtpCommand(
          socket,
          Buffer.from(cramResponse).toString('base64'),
          '235',
        )
        return
      }
      catch (error) {
        const errorMessage = (error as Error).message
        if (errorMessage.includes('535') || errorMessage.includes('Authentication failed')) {
          throw createError(PROVIDER_NAME, 'Authentication failed: Invalid username or password')
        }
        throw error
      }
    }

    if (authMethod === 'LOGIN' && options.password) {
      try {
        await sendSmtpCommand(socket, 'AUTH LOGIN', '334')

        await sendSmtpCommand(
          socket,
          Buffer.from(options.user).toString('base64'),
          '334',
        )

        await sendSmtpCommand(
          socket,
          Buffer.from(options.password).toString('base64'),
          '235',
        )
        return
      }
      catch (error) {
        const errorMessage = (error as Error).message
        if (errorMessage.includes('535') || errorMessage.includes('Authentication failed')) {
          throw createError(PROVIDER_NAME, 'Authentication failed: Invalid username or password')
        }
        throw error
      }
    }

    if (authMethod === 'PLAIN' && options.password) {
      try {
        const authPlain = Buffer.from(`\0${options.user}\0${options.password}`).toString('base64')
        await sendSmtpCommand(
          socket,
          `AUTH PLAIN ${authPlain}`,
          '235',
        )
        return
      }
      catch (error) {
        const errorMessage = (error as Error).message
        if (errorMessage.includes('535') || errorMessage.includes('Authentication failed')) {
          throw createError(PROVIDER_NAME, 'Authentication failed: Invalid username or password')
        }
        throw error
      }
    }

    throw createError(PROVIDER_NAME, 'Authentication failed - no valid credentials or method')
  }

  const signWithDkim = (message: string): string => {
    if (!options.dkim) {
      return message
    }

    const { domainName, keySelector, privateKey } = options.dkim

    try {
      const parts = message.split('\r\n\r\n')
      const headersPart = parts[0] ?? ''
      const bodyPart = parts[1] ?? ''
      const headers = headersPart.split('\r\n')

      const canonicalize = (str: string) => str.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
      const canonicalizedBody = canonicalize(bodyPart)
      const bodyHash = crypto.createHash('sha256').update(canonicalizedBody).digest('base64')

      const headerNames = ['from', 'to', 'subject', 'date']
      const headersToSign = headers.filter(h => headerNames.some(n => h.toLowerCase().startsWith(`${n}:`)))
      const dkimHeaderList = headersToSign.map((h) => {
        const part = h.split(':')[0]
        return part ? part.toLowerCase() : ''
      }).join(':')

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

      const headersForSign = [...headersToSign, dkimHeader].map(canonicalize).join('\r\n')
      const signer = crypto.createSign('RSA-SHA256')
      signer.update(headersForSign)
      const signature = signer.sign(privateKey, 'base64')
      const finalDkimHeader = `${dkimHeader}${signature}`

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
      batchSending: options.pool,
      tagging: false,
      scheduling: false,
      replyTo: true,
    },
    options,

    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      try {
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

    async isAvailable(): Promise<boolean> {
      try {
        const portAvailable = await isPortAvailable(options.host, options.port)

        if (!portAvailable) {
          return false
        }

        const socket = await createSmtpConnection()
        await closeConnection(socket)

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

        let socket = await createSmtpConnection()

        try {
          await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')

          if (!options.secure) {
            try {
              const ehloResponse = await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              const capabilities = parseEhloResponse(ehloResponse)

              if (Object.keys(capabilities).includes('STARTTLS')) {
                await sendSmtpCommand(socket, 'STARTTLS', '220')

                const tlsSocket = await upgradeToTLS(socket)

                socket = tlsSocket

                await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              }
            }
            catch (error) {
              if (options.rejectUnauthorized !== false) {
                throw createError(
                  PROVIDER_NAME,
                  `STARTTLS failed or not supported: ${(error as Error).message}`,
                  { cause: error as Error },
                )
              }
            }
          }

          await authenticate(socket)

          await sendSmtpCommand(
            socket,
            `MAIL FROM:<${emailOpts.from.email}>`,
            '250',
          )

          const recipients: string[] = []

          if (Array.isArray(emailOpts.to)) {
            recipients.push(...emailOpts.to.map(r => r.email))
          }
          else {
            recipients.push(emailOpts.to.email)
          }

          if (emailOpts.cc) {
            if (Array.isArray(emailOpts.cc)) {
              recipients.push(...emailOpts.cc.map(r => r.email))
            }
            else {
              recipients.push(emailOpts.cc.email)
            }
          }

          if (emailOpts.bcc) {
            if (Array.isArray(emailOpts.bcc)) {
              recipients.push(...emailOpts.bcc.map(r => r.email))
            }
            else {
              recipients.push(emailOpts.bcc.email)
            }
          }

          for (const recipient of recipients) {
            await sendSmtpCommand(
              socket,
              `RCPT TO:<${recipient}>`,
              '250',
            )
          }

          await sendSmtpCommand(socket, 'DATA', '354')

          let mimeMessage = buildMimeMessage(emailOpts)

          const additionalHeaders: string[] = []

          if (emailOpts.dsn) {
            const dsnOptions: string[] = []
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

          if (emailOpts.inReplyTo) {
            additionalHeaders.push(`In-Reply-To: ${sanitizeHeaderValue(emailOpts.inReplyTo)}`)
          }

          if (emailOpts.references) {
            const refs = Array.isArray(emailOpts.references)
              ? emailOpts.references.map(sanitizeHeaderValue).join(' ')
              : sanitizeHeaderValue(emailOpts.references)

            additionalHeaders.push(`References: ${refs}`)
          }

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

          if (emailOpts.googleMailHeaders) {
            const { googleMailHeaders } = emailOpts

            if (googleMailHeaders.feedbackId) {
              additionalHeaders.push(
                `Feedback-ID: ${sanitizeHeaderValue(googleMailHeaders.feedbackId)}`,
              )
            }

            if (googleMailHeaders.promotionalContent) {
              additionalHeaders.push('X-Google-Promotion: promotional')
            }

            if (googleMailHeaders.category) {
              additionalHeaders.push(`X-Gmail-Labels: ${googleMailHeaders.category}`)
            }
          }

          if (additionalHeaders.length > 0) {
            const splitIndex = mimeMessage.indexOf('\r\n\r\n')
            if (splitIndex !== -1) {
              const headerPart = mimeMessage.slice(0, splitIndex)
              const bodyPart = mimeMessage.slice(splitIndex + 4)
              mimeMessage = `${headerPart}\r\n${additionalHeaders.join('\r\n')}\r\n\r\n${bodyPart}`
            }
          }

          if (options.dkim && (emailOpts.useDkim || emailOpts.useDkim === undefined)) {
            mimeMessage = signWithDkim(mimeMessage)
          }

          await sendSmtpCommand(socket, `${mimeMessage}\r\n.`, '250')

          const messageId = generateMessageId()

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

    async validateCredentials(): Promise<boolean> {
      try {
        if (!await this.isAvailable()) {
          return false
        }

        const socket = await createSmtpConnection()

        try {
          await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')

          if (!options.secure) {
            try {
              const ehloResponse = await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              const capabilities = parseEhloResponse(ehloResponse)

              if (Object.keys(capabilities).includes('STARTTLS')) {
                await sendSmtpCommand(socket, 'STARTTLS', '220')

                const tlsSocket = await upgradeToTLS(socket)

                Object.assign(socket, tlsSocket)

                await sendSmtpCommand(socket, `EHLO ${options.host}`, '250')
              }
            }
            catch {
              if (options.rejectUnauthorized !== false) {
                return false
              }
            }
          }

          await authenticate(socket)

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

    async shutdown(): Promise<void> {
      for (const socket of connectionPool) {
        try {
          await closeConnection(socket)
        }
        catch {
          // Ignore errors during shutdown
        }
      }

      connectionPool.length = 0

      for (const queueItem of connectionQueue) {
        clearTimeout(queueItem.timeout)
        queueItem.reject(new Error('Provider shutdown'))
      }

      connectionQueue.length = 0
    },
  }
})

export default smtpProvider
