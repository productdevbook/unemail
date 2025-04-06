import type { EmailOptions } from 'unemail/types'

/**
 * AWS SES-specific email options
 */
export interface AwsSesEmailOptions extends EmailOptions {
  /**
   * Configuration ID for sending via a specific AWS SES configuration set
   * @see https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html#API_SendEmail_RequestParameters
   */
  configurationSetName?: string

  /**
   * Custom message tags for classification
   * @see https://docs.aws.amazon.com/ses/latest/APIReference/API_MessageTag.html
   */
  messageTags?: Record<string, string>

  /**
   * Source ARN for sending authorization
   * @see https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html#API_SendEmail_RequestParameters
   */
  sourceArn?: string

  /**
   * Return path for bounces
   */
  returnPath?: string

  /**
   * Return path ARN
   */
  returnPathArn?: string
}
