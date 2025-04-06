import type { EmailOptions } from 'unemail/types'

/**
 * HTTP-specific email options
 */
export interface HttpEmailOptions extends EmailOptions {
  /**
   * Additional custom parameters to include in the HTTP request
   */
  customParams?: Record<string, any>

  /**
   * Override the endpoint for this specific email
   */
  endpointOverride?: string

  /**
   * Override the HTTP method for this specific email
   */
  methodOverride?: 'GET' | 'POST' | 'PUT'
}
