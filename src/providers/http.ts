import type { EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { createError, generateMessageId, makeRequest, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types
// ============================================================================

export interface HttpOptions {
  endpoint: string
  apiKey?: string
  method?: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
}

export interface HttpEmailOptions extends EmailOptions {
  customParams?: Record<string, any>
  endpointOverride?: string
  methodOverride?: 'GET' | 'POST' | 'PUT'
}

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = 'http'
const DEFAULT_METHOD = 'POST'
const DEFAULT_TIMEOUT = 30000

// ============================================================================
// Provider Implementation
// ============================================================================

export const httpProvider: ProviderFactory<HttpOptions, any, HttpEmailOptions> = defineProvider((opts: HttpOptions = {} as HttpOptions) => {
  if (!opts.endpoint) {
    throw new Error('Missing required option: endpoint')
  }

  const options: Required<HttpOptions> = {
    endpoint: opts.endpoint,
    apiKey: opts.apiKey || '',
    method: opts.method || DEFAULT_METHOD,
    headers: opts.headers || {},
  }

  const getStandardHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    }

    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`
    }

    return headers
  }

  const formatRequest = (emailOpts: HttpEmailOptions): Record<string, any> => {
    const payload: Record<string, any> = {
      from: emailOpts.from.email,
      from_name: emailOpts.from.name,
      to: Array.isArray(emailOpts.to)
        ? emailOpts.to.map(r => r.email)
        : emailOpts.to.email,
      subject: emailOpts.subject,
      text: emailOpts.text,
      html: emailOpts.html,
    }

    if (emailOpts.cc) {
      payload.cc = Array.isArray(emailOpts.cc)
        ? emailOpts.cc.map(r => r.email)
        : emailOpts.cc.email
    }

    if (emailOpts.bcc) {
      payload.bcc = Array.isArray(emailOpts.bcc)
        ? emailOpts.bcc.map(r => r.email)
        : emailOpts.bcc.email
    }

    if (emailOpts.customParams) {
      Object.assign(payload, emailOpts.customParams)
    }

    return payload
  }

  let isInitialized = false

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

    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      if (!await this.isAvailable()) {
        throw new Error('API endpoint not available')
      }

      isInitialized = true
    },

    async isAvailable(): Promise<boolean> {
      try {
        const result = await makeRequest(
          options.endpoint,
          {
            method: 'OPTIONS',
            headers: getStandardHeaders(),
            timeout: DEFAULT_TIMEOUT,
          },
        )

        if (result.success) {
          return true
        }

        if (result.data?.statusCode && result.data.statusCode >= 400 && result.data.statusCode < 500) {
          return true
        }

        return false
      }
      catch (error) {
        if (error instanceof Error) {
          const errorMsg = error.message
          if (errorMsg.includes('status 4') || errorMsg.includes('401') || errorMsg.includes('403')) {
            return true
          }
        }
        return false
      }
    },

    async sendEmail(emailOpts: HttpEmailOptions): Promise<Result<EmailResult>> {
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

        const headers = getStandardHeaders()

        if (emailOpts.headers) {
          Object.assign(headers, emailOpts.headers)
        }

        const payload = formatRequest(emailOpts)

        const endpoint = emailOpts.endpointOverride || options.endpoint

        const method = emailOpts.methodOverride || options.method

        const result = await makeRequest(
          endpoint,
          {
            method,
            headers,
            timeout: DEFAULT_TIMEOUT,
          },
          JSON.stringify(payload),
        )

        if (!result.success) {
          return {
            success: false,
            error: createError(
              PROVIDER_NAME,
              `Failed to send email: ${result.error?.message || 'Unknown error'}`,
              { cause: result.error },
            ),
          }
        }

        let messageId
        const responseBody = result.data?.body
        if (responseBody) {
          messageId = responseBody.id
            || responseBody.messageId
            || (responseBody.data && (responseBody.data.id || responseBody.data.messageId))
        }

        if (!messageId) {
          messageId = generateMessageId()
        }

        return {
          success: true,
          data: {
            messageId,
            sent: true,
            timestamp: new Date(),
            provider: PROVIDER_NAME,
            response: result.data?.body,
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
      try {
        const result = await makeRequest(
          options.endpoint,
          {
            method: 'GET',
            headers: getStandardHeaders(),
            timeout: DEFAULT_TIMEOUT,
          },
        )

        if (result.data?.statusCode && result.data.statusCode >= 200 && result.data.statusCode < 300) {
          return true
        }
        return false
      }
      catch {
        return false
      }
    },
  }
})

export default httpProvider
