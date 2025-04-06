import type { EmailOptions } from 'unemail/types'
import { createEmailService } from 'unemail'
import mailcrabProvider from 'unemail/providers/mailcrab'
import { beforeAll, describe, expect, it } from 'vitest'

describe('mailCrab Integration Test', () => {
  const emailService = createEmailService({
    provider: mailcrabProvider,
    debug: true,
    config: {
      options: {
        host: 'localhost',
        port: 1025, // Default MailCrab SMTP port
      },
    },
  })

  beforeAll(async () => {
    // Skip initialization for now as it requires MailCrab to be running
    // This is just an example test file
    // await emailService.initialize();
  })

  it('should create email service with MailCrab provider', () => {
    expect(emailService).toBeDefined()
  })

  it('demonstrates sending an email', async () => {
    // This test is not meant to be run automatically
    // It's just to demonstrate the API usage

    const emailOptions: EmailOptions = {
      from: { email: 'sender@example.com', name: 'Sender Name' },
      to: { email: 'recipient@example.com', name: 'Recipient Name' },
      subject: 'Test Email from unemail',
      text: 'This is a plain text email body',
      html: '<h1>Hello</h1><p>This is an HTML email body</p>',
      attachments: [
        {
          filename: 'test.txt',
          content: 'This is a test attachment',
          contentType: 'text/plain',
        },
      ],
    }

    // Comment out actual sending since this is just an example
    const result = await emailService.sendEmail(emailOptions)
    expect(result.success).toBe(true)
  })
})
