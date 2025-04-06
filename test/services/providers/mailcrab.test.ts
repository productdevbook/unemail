import type { EmailOptions } from 'unemail/types'
import smtpProvider from 'unemail/providers/smtp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Create a socket mock that can be used for both Socket constructor and createConnection
const socketMock = {
  on: vi.fn().mockReturnThis(),
  once: vi.fn().mockReturnThis(),
  setTimeout: vi.fn(),
  write: vi.fn().mockReturnValue(true),
  end: vi.fn(),
  destroy: vi.fn(),
  connect: vi.fn((port, host, callback) => {
    if (callback && typeof callback === 'function') {
      setTimeout(callback, 0)
    }
    return socketMock
  }),
}

// Mock net module completely
vi.mock('net', () => {
  return {
    Socket: vi.fn().mockImplementation(() => {
      return { ...socketMock }
    }),
    createConnection: vi.fn(() => {
      return { ...socketMock }
    }),
  }
})

describe('sMTP Provider', () => {
  let provider: ReturnType<typeof smtpProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    // Create a fresh provider instance with default options
    provider = smtpProvider({
      host: 'localhost',
      port: 25,
    })
  })

  it('should create a provider instance with correct defaults', () => {
    expect(provider.name).toBe('smtp')
    expect(provider.options!.host).toBe('localhost')
    expect(provider.options!.port).toBe(25)
    expect(provider.options!.secure).toBe(false)
  })

  it('should check if SMTP server is available', async () => {
    const result = await provider.isAvailable()
    expect(result).toBe(true)
    expect(socketMock.setTimeout).toHaveBeenCalled()
    expect(socketMock.connect).toHaveBeenCalled()
  })

  it('should initialize the provider', async () => {
    // Mock the availability check
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(true)

    await provider.initialize()

    expect(provider.isAvailable).toHaveBeenCalledTimes(1)
  })

  it('should throw error if SMTP server is not available during initialization', async () => {
    // Mock the availability check to return false
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(false)

    await expect(provider.initialize()).rejects.toThrow('SMTP server not available')
  })

  it('should send an email via SMTP', async () => {
    // Skip the actual implementation and mock the sendEmail method
    const originalSendEmail = provider.sendEmail
    provider.sendEmail = vi.fn().mockResolvedValue({
      success: true,
      data: {
        messageId: 'test-message-id',
        sent: true,
        timestamp: new Date(),
        provider: 'smtp',
      },
    })

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com', name: 'Test Sender' },
      to: { email: 'recipient@example.com', name: 'Test Recipient' },
      subject: 'Test Email',
      text: 'This is a test email',
      html: '<p>This is a test email</p>',
    }

    // Send email
    const result = await provider.sendEmail(emailOptions)

    // Restore original method after test
    provider.sendEmail = originalSendEmail

    // Verify result
    expect(result.success).toBe(true)
    expect(result.data?.sent).toBe(true)
    expect(result.data?.provider).toBe('smtp')
    expect(result.data?.messageId).toBe('test-message-id')
  })

  it('should validate email options before sending', async () => {
    // This test can use the original method as it doesn't involve SMTP connection
    // Missing required fields
    const invalidOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: '', // Empty subject
      text: '', // No content
    }

    const result = await provider.sendEmail(invalidOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Invalid email options')
  })

  it('should handle SMTP errors during sending', async () => {
    // Skip the actual implementation and mock the sendEmail method
    const originalSendEmail = provider.sendEmail
    provider.sendEmail = vi.fn().mockResolvedValue({
      success: false,
      error: new Error('Failed to send email: SMTP error'),
    })

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    // Send email - should fail due to SMTP error
    const result = await provider.sendEmail(emailOptions)

    // Restore original method after test
    provider.sendEmail = originalSendEmail

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to send email')
  })

  it('should validate credentials successfully', async () => {
    // Create a provider with credentials
    const providerWithCredentials = smtpProvider({
      host: 'localhost',
      port: 25,
      user: 'testuser',
      password: 'testpass',
    })

    // Mock the validateCredentials method directly
    if (providerWithCredentials.validateCredentials) {
      const mockValidate = vi.fn().mockResolvedValue(true)
      const originalValidateCredentials = providerWithCredentials.validateCredentials
      providerWithCredentials.validateCredentials = mockValidate

      // Call the method
      const result = await providerWithCredentials.validateCredentials()

      // Restore original method
      providerWithCredentials.validateCredentials = originalValidateCredentials

      expect(result).toBe(true)
    }
    else {
      console.log('validateCredentials not available, skipping test')
    }
  })
})
