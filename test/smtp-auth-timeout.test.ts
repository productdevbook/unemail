import { describe, expect, it, vi } from 'vitest'
import { createEmailService } from '../src/email.ts'
import smtpProvider from '../src/providers/smtp.ts'

// Hoist the mock transporter to be available during vi.mock
const { mockTransporter } = vi.hoisted(() => {
  const mockTransporter = {
    verify: vi.fn().mockRejectedValue(new Error('Connection timeout')),
    sendMail: vi.fn().mockRejectedValue(new Error('Authentication failed')),
    close: vi.fn(),
  }
  return { mockTransporter }
})

// Mock nodemailer
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => mockTransporter),
  },
  createTransport: vi.fn(() => mockTransporter),
}))

describe('smtp Authentication Timeout', () => {
  it('should timeout and return error when using incorrect credentials', async () => {
    // Reset mock
    mockTransporter.sendMail.mockRejectedValue(new Error('Authentication failed: wrong credentials'))

    // Create email service with wrong credentials
    const emailService = createEmailService({
      provider: smtpProvider({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: {
          user: 'test@example.com',
          pass: 'wrongpassword',
        },
        connectionTimeout: 2000, // 2 second timeout
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
    expect(result.error?.message).toMatch(/(Authentication failed|timeout|Connection|Failed)/i)
  })

  it('should handle authentication errors gracefully', async () => {
    // Reset mock to simulate connection error
    mockTransporter.verify.mockRejectedValue(new Error('Connection refused'))
    mockTransporter.sendMail.mockRejectedValue(new Error('Connection refused'))

    // Create email service with invalid credentials to a test SMTP server
    const emailService = createEmailService({
      provider: smtpProvider({
        host: 'localhost',
        port: 1025,
        secure: false,
        auth: {
          user: 'testuser',
          pass: 'wrongpassword',
        },
        connectionTimeout: 3000, // 3 second timeout
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
  })
})
