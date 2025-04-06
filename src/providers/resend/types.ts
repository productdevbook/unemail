import type { EmailOptions, EmailTag } from 'unemail/types'

/**
 * Resend-specific email tag type with additional constraints
 * @see https://resend.com/docs/api-reference/emails/send-email#tags
 */
export interface ResendEmailTag extends EmailTag {
  /**
   * Tag name - must only contain ASCII letters, numbers, underscores, or dashes
   * Max length: 256 characters
   */
  name: string

  /**
   * Tag value - must only contain ASCII letters, numbers, underscores, or dashes
   */
  value: string
}

/**
 * Resend-specific email options
 */
export interface ResendEmailOptions extends EmailOptions {
  /**
   * Template ID for template-based emails
   */
  templateId?: string

  /**
   * Template data for template-based emails
   */
  templateData?: Record<string, any>

  /**
   * Schedule email for delivery at a specific time
   */
  scheduledAt?: Date | string

  /**
   * Tags for categorizing emails
   * Resend allows tagging emails for tracking and categorization
   * Each tag must follow Resend's specific format requirements
   */
  tags?: ResendEmailTag[]
}
