import { describe, expect, it } from 'vitest'
import { createEmailService } from '../src/core.ts'
import smtpProvider from '../src/providers/smtp/index.ts'

describe('smtp Authentication Timeout', () => {
  it('should timeout and return error when using incorrect credentials', async () => {
    // Create email service with wrong credentials and short timeout
    const emailService = createEmailService({
      provider: smtpProvider({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        user: 'test@example.com',
        password: 'wrongpassword',
        timeout: 5000, // 5 second timeout
      }),
    })

    // Try to send an email
    const result = await emailService.sendEmail({
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This should fail due to wrong credentials',
    })

    // Verify that it returns an error
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error?.message).toMatch(/(Authentication failed|timeout|Connection)/i)
  }, 10000) // Test timeout of 10 seconds

  it('should handle authentication errors gracefully', async () => {
    // Create email service with invalid credentials to a test SMTP server
    const emailService = createEmailService({
      provider: smtpProvider({
        host: 'localhost',
        port: 1025,
        secure: false,
        user: 'testuser',
        password: 'wrongpassword',
        timeout: 3000, // 3 second timeout
      }),
    })

    // Try to send an email
    const result = await emailService.sendEmail({
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'Testing authentication error handling',
    })

    // If the SMTP server is not available, it should return an error
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  }, 10000)
})
