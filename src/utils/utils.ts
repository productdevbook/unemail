import type { ErrorOptions, Result } from 'unemail/types'
import { Buffer } from 'node:buffer'
import * as http from 'node:http'
import * as https from 'node:https'
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
