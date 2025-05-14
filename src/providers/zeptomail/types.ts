import type { EmailOptions } from 'unemail/types'

/**
 * Zeptomail-specific email options
 */
export interface ZeptomailEmailOptions extends EmailOptions {
  /**
   * Track email clicks - enables tracking for click events
   */
  trackClicks?: boolean

  /**
   * Track email opens - enables tracking for open events
   */
  trackOpens?: boolean

  /**
   * Client reference - identifier set by the user to track a particular transaction
   */
  clientReference?: string

  /**
   * MIME headers - additional headers sent in the email for reference
   */
  mimeHeaders?: Record<string, string>
}
