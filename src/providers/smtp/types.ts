import type { EmailOptions } from 'unemail/types'

/**
 * SMTP-specific email options
 */
export interface SmtpEmailOptions extends EmailOptions {
  // SMTP specific options
  dsn?: {
    /** Request successful delivery notification */
    success?: boolean
    /** Request notification on failure */
    failure?: boolean
    /** Request notification on delay */
    delay?: boolean
  }

  /** Message priority: 'high', 'normal', or 'low' */
  priority?: 'high' | 'normal' | 'low'
}
