import type { EmailOptions } from 'unemail/types'
import { Buffer } from 'node:buffer'
import resendProvider from 'unemail/providers/resend'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist the mock objects to be available during vi.mock
const { mockResendEmails, MockResend } = vi.hoisted(() => {
  const mockResendEmails = {
    send: vi.fn().mockResolvedValue({
      data: { id: 'server-message-id' },
      error: null,
    }),
    get: vi.fn().mockResolvedValue({
      data: {
        id: 'test-email-id',
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        created_at: '2024-01-01T00:00:00.000Z',
      },
      error: null,
    }),
  }

  // Create a proper constructor mock
  class MockResend {
    emails = mockResendEmails
    constructor(_apiKey: string) {
      // Store apiKey if needed
    }
  }

  return { mockResendEmails, MockResend }
})

// Mock resend package
vi.mock('resend', () => ({
  Resend: MockResend,
}))

// Mock the utility functions
vi.mock('unemail/utils', () => ({
  createError: (component: string, message: string) => new Error(`[unemail] [${component}] ${message}`),
  createRequiredError: (component: string, name: string) => new Error(`[unemail] [${component}] Missing required option: '${name}'`),
  validateEmailOptions: vi.fn().mockReturnValue([]),
}))

describe('resend Provider', () => {
  let provider: ReturnType<typeof resendProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    // Reset mock implementations
    mockResendEmails.send.mockResolvedValue({
      data: { id: 'server-message-id' },
      error: null,
    })
    mockResendEmails.get.mockResolvedValue({
      data: {
        id: 'test-email-id',
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        created_at: '2024-01-01T00:00:00.000Z',
      },
      error: null,
    })

    // Create a fresh provider instance for each test
    provider = resendProvider({
      apiKey: 're_test-api-key',
    })
  })

  it('should create a provider instance with correct options', () => {
    expect(provider.name).toBe('resend')
    expect(provider.options!.apiKey).toBe('re_test-api-key')
  })

  it('should throw error if apiKey is not provided', () => {
    expect(() => {
      resendProvider({ apiKey: '' })
    }).toThrow('[unemail] [resend] Missing required option: \'apiKey\'')
  })

  it('should check if Resend API is available', async () => {
    const result = await provider.isAvailable()

    expect(result).toBe(true)
  })

  it('should consider API unavailable with invalid API key format', async () => {
    const invalidProvider = resendProvider({
      apiKey: 'invalid-api-key',
    })

    const result = await invalidProvider.isAvailable()

    expect(result).toBe(false)
  })

  it('should initialize successfully with valid API key', async () => {
    await provider.initialize()

    // Should not throw an error
    expect(provider.options!.apiKey).toBe('re_test-api-key')
  })

  it('should throw error during initialization with invalid API key format', async () => {
    const invalidProvider = resendProvider({
      apiKey: 'invalid-api-key',
    })

    await expect(invalidProvider.initialize()).rejects.toThrow('Invalid API key format')
  })

  it('should send an email successfully', async () => {
    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com', name: 'Test Sender' },
      to: [
        { email: 'recipient1@example.com', name: 'Recipient 1' },
        { email: 'recipient2@example.com', name: 'Recipient 2' },
      ],
      subject: 'Test Email',
      text: 'This is a test email',
      html: '<p>This is a test email</p>',
      attachments: [
        {
          filename: 'test.txt',
          content: Buffer.from('Test attachment content'),
          contentType: 'text/plain',
        },
      ],
      headers: {
        'X-Test-Header': 'test-value',
      },
    }

    // Send email
    const result = await provider.sendEmail(emailOptions)

    // Verify result
    expect(result.success).toBe(true)
    expect(result.data?.messageId).toBe('server-message-id')
    expect(result.data?.provider).toBe('resend')
    expect(result.data?.sent).toBe(true)

    // Verify Resend client was called
    expect(mockResendEmails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Test Sender <test@example.com>',
        to: ['Recipient 1 <recipient1@example.com>', 'Recipient 2 <recipient2@example.com>'],
        subject: 'Test Email',
        text: 'This is a test email',
        html: '<p>This is a test email</p>',
      }),
    )
  })

  it('should validate email options before sending', async () => {
    // Import the actual utils module to mock just the validateEmailOptions function
    const utils = await import('unemail/utils')

    // Mock validation errors
    vi.mocked(utils.validateEmailOptions).mockReturnValueOnce(['Missing subject'])

    // Create invalid email options (missing required fields)
    const invalidOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: '', // Empty subject
      text: '', // No content
    }

    const result = await provider.sendEmail(invalidOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Invalid email options')
    // Make sure Resend API was not called
    expect(mockResendEmails.send).not.toHaveBeenCalled()
  })

  it('should handle API errors during sending', async () => {
    // Mock Resend to return an error
    mockResendEmails.send.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid API Key' },
    })

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    // Send email - should fail due to API error
    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to send email')
  })

  it('should handle exceptions during sending', async () => {
    // Mock Resend to throw an exception
    mockResendEmails.send.mockRejectedValueOnce(new Error('Network error'))

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    // Send email - should fail due to exception
    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to send email')
  })

  it('should validate credentials', async () => {
    const result = await provider.validateCredentials!()
    expect(result).toBe(true)
  })

  it('should handle failed credential validation', async () => {
    const invalidProvider = resendProvider({
      apiKey: 'invalid-api-key',
    })

    const result = await invalidProvider.validateCredentials!()
    expect(result).toBe(false)
  })

  it('should retrieve email by ID', async () => {
    const result = await provider.getEmail!('test-email-id')

    expect(result.success).toBe(true)
    expect(result.data).toEqual(expect.objectContaining({
      id: 'test-email-id',
      from: 'sender@example.com',
    }))
    expect(mockResendEmails.get).toHaveBeenCalledWith('test-email-id')
  })

  it('should handle error when retrieving email', async () => {
    mockResendEmails.get.mockResolvedValueOnce({
      data: null,
      error: { message: 'Email not found' },
    })

    const result = await provider.getEmail!('non-existent-id')

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to retrieve email')
  })

  it('should return error when email ID is not provided', async () => {
    const result = await provider.getEmail!('')

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Email ID is required')
  })

  it('should send email with tags', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email with Tags',
      text: 'This is a test email',
      tags: [
        { name: 'category', value: 'test' },
        { name: 'version', value: 'v1' },
      ],
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockResendEmails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          { name: 'category', value: 'test' },
          { name: 'version', value: 'v1' },
        ],
      }),
    )
  })

  it('should send email with scheduled delivery', async () => {
    const scheduledDate = new Date('2025-01-01T10:00:00.000Z')

    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Scheduled Email',
      text: 'This is a scheduled email',
      scheduledAt: scheduledDate,
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockResendEmails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAt: '2025-01-01T10:00:00.000Z',
      }),
    )
  })

  it('should send email with cc and bcc', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      cc: { email: 'cc@example.com', name: 'CC User' },
      bcc: [
        { email: 'bcc1@example.com' },
        { email: 'bcc2@example.com' },
      ],
      subject: 'Test Email',
      text: 'This is a test email',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockResendEmails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: ['CC User <cc@example.com>'],
        bcc: ['bcc1@example.com', 'bcc2@example.com'],
      }),
    )
  })

  it('should send email with replyTo', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      replyTo: { email: 'reply@example.com', name: 'Reply Handler' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockResendEmails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: ['Reply Handler <reply@example.com>'],
      }),
    )
  })

  it('should return getInstance that provides Resend client', () => {
    const instance = provider.getInstance!()
    expect(instance).toBeInstanceOf(MockResend)
  })
})
