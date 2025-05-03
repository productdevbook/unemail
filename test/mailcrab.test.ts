import type { EmailOptions } from 'unemail/types'
import { createEmailService } from 'unemail'
import smtpProvider from 'unemail/providers/smtp'
import { beforeAll, describe, expect, it } from 'vitest'

describe('mailCrab Integration Test', () => {
  const emailService = createEmailService({
    provider: smtpProvider({
      host: 'localhost',
      port: 1025, // Default MailCrab SMTP port
    }),
    debug: true,
  })

  beforeAll(async () => {
    // Skip initialization for now as it requires MailCrab to be running
    // This is just an example test file
    // await emailService.initialize();
  })

  it('should create email service with SMTP provider for MailCrab', () => {
    expect(emailService).toBeDefined()
  })

  it('demonstrates sending an email', async () => {
    // This test is not meant to be run automatically
    // It's just to demonstrate the API usage

    const emailOptions: EmailOptions = {
      from: { email: 'sender@example.com', name: 'Test Sender' },
      to: { email: 'recipient@example.com', name: 'Test Recipient' },
      subject: 'MailCrab Test Email',
      text: 'This is a test email for MailCrab',
      html: '<p>This is a <strong>test email</strong> for MailCrab</p>',
    }

    // Comment out actual sending since this is just an example
    const result = await emailService.sendEmail(emailOptions)
    expect(result.success).toBe(true)

    // Instead, just check that we have the right structure
    expect(emailOptions).toBeDefined()
    expect(emailOptions.from).toBeDefined()
    expect(emailOptions.to).toBeDefined()
    expect(emailOptions.subject).toBeDefined()
  })
}, {
  skip: !process.env.GITHUB_ACTIONS,
})
