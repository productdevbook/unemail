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

  /** Reference to a previous message ID (for threading) */
  inReplyTo?: string

  /** References to related message IDs */
  references?: string | string[]

  /** List-Unsubscribe header for easy unsubscribe functionality */
  listUnsubscribe?: string | string[]

  /** Special Google Mail headers */
  googleMailHeaders?: {
    /** Mark as promotional content */
    promotionalContent?: boolean

    /** Feedback ID for engagement tracking */
    feedbackId?: string

    /** Category for email organization */
    category?: 'primary' | 'social' | 'promotions' | 'updates' | 'forums'
  }

  /** Whether to sign the email with DKIM */
  useDkim?: boolean
}
