import type { $Fetch, FetchError, FetchOptions } from 'ofetch'
import type { EmailOptions, EmailResult, Result } from '../types.ts'
import type { ProviderFactory } from './utils/index.ts'
import { ofetch } from 'ofetch'
import { createError, generateMessageId, validateEmailOptions } from '../utils.ts'
import { defineProvider } from './utils/index.ts'

// ============================================================================
// Types - Re-export from ofetch
// ============================================================================

export type { FetchError, FetchOptions }

export interface HttpOptions {
  endpoint: string
  apiKey?: string
  method?: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
  timeout?: number
  retry?: number
}

export interface HttpEmailOptions extends EmailOptions {
  customParams?: Record<string, unknown>
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

export const httpProvider: ProviderFactory<HttpOptions, $Fetch, HttpEmailOptions> = defineProvider((opts: HttpOptions = {} as HttpOptions) => {
  if (!opts.endpoint) {
    throw createError(PROVIDER_NAME, 'Missing required option: endpoint')
  }

  const options: HttpOptions = {
    endpoint: opts.endpoint,
    apiKey: opts.apiKey,
    method: opts.method ?? DEFAULT_METHOD,
    headers: opts.headers ?? {},
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    retry: opts.retry ?? 0,
  }

  let fetchInstance: $Fetch | null = null
  let isInitialized = false

  const getFetch = (): $Fetch => {
    if (!fetchInstance) {
      const defaultHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...options.headers,
      }

      if (options.apiKey) {
        defaultHeaders.Authorization = `Bearer ${options.apiKey}`
      }

      fetchInstance = ofetch.create({
        timeout: options.timeout,
        retry: options.retry,
        headers: defaultHeaders,
      })
    }
    return fetchInstance
  }

  const formatRequest = (emailOpts: HttpEmailOptions): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
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

  return {
    name: PROVIDER_NAME,
    options,

    getInstance: () => getFetch(),

    async initialize(): Promise<void> {
      if (isInitialized) {
        return
      }

      try {
        getFetch()
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
        const fetch = getFetch()
        await fetch.raw(options.endpoint, {
          method: 'OPTIONS',
        })
        return true
      }
      catch (error) {
        const fetchError = error as FetchError
        // 4xx errors mean the endpoint exists (auth error is still "available")
        if (fetchError.status && fetchError.status >= 400 && fetchError.status < 500) {
          return true
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

        const fetch = getFetch()
        const payload = formatRequest(emailOpts)
        const endpoint = emailOpts.endpointOverride ?? options.endpoint
        const method = emailOpts.methodOverride ?? options.method

        const requestHeaders = emailOpts.headers ? { ...emailOpts.headers } : undefined

        const response = await fetch<Record<string, unknown>>(endpoint, {
          method,
          body: payload,
          headers: requestHeaders,
        })

        let messageId: string | undefined
        if (response) {
          messageId = (response.id as string)
            ?? (response.messageId as string)
            ?? ((response.data as Record<string, unknown>)?.id as string)
            ?? ((response.data as Record<string, unknown>)?.messageId as string)
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
            response,
          },
        }
      }
      catch (error) {
        const fetchError = error as FetchError
        return {
          success: false,
          error: createError(
            PROVIDER_NAME,
            `Failed to send email: ${fetchError.message}`,
            { cause: error as Error },
          ),
        }
      }
    },

    async validateCredentials(): Promise<boolean> {
      try {
        const fetch = getFetch()
        await fetch.raw(options.endpoint, {
          method: 'GET',
        })
        return true
      }
      catch (error) {
        const fetchError = error as FetchError
        // 2xx means valid credentials
        if (fetchError.status && fetchError.status >= 200 && fetchError.status < 300) {
          return true
        }
        return false
      }
    },
  }
})

export default httpProvider
