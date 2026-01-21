import type { SmtpEmailOptions } from 'unemail/providers/smtp'
import type { EmailOptions } from 'unemail/types'
import { Buffer } from 'node:buffer'
import smtpProvider from 'unemail/providers/smtp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist the mock transporter to be available during vi.mock
const { mockTransporter } = vi.hoisted(() => {
  const mockTransporter = {
    verify: vi.fn().mockResolvedValue(true),
    sendMail: vi.fn().mockResolvedValue({
      messageId: 'test-message-id@example.com',
      accepted: ['recipient@example.com'],
      rejected: [],
      response: '250 OK',
    }),
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

// Mock the utility functions
vi.mock('unemail/utils', () => ({
  createError: vi.fn((component, message) => new Error(`[unemail] [${component}] ${message}`)),
  createRequiredError: vi.fn((component, name) =>
    new Error(`[unemail] [${component}] Missing required option: '${name}'`)),
  validateEmailOptions: vi.fn().mockReturnValue([]), // No validation errors by default
}))

describe('sMTP Provider', () => {
  let provider: ReturnType<typeof smtpProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    // Reset mock implementations
    mockTransporter.verify.mockResolvedValue(true)
    mockTransporter.sendMail.mockResolvedValue({
      messageId: 'test-message-id@example.com',
      accepted: ['recipient@example.com'],
      rejected: [],
      response: '250 OK',
    })
    mockTransporter.close.mockReset()

    // Create a fresh provider instance with default options
    provider = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
    })
  })

  it('should create a provider instance with correct defaults', () => {
    expect(provider.name).toBe('smtp')
    expect(provider.options!.host).toBe('smtp.example.com')
    expect(provider.options!.port).toBe(587)
    expect(provider.options!.secure).toBe(false)
  })

  it('should use provided ports', () => {
    const secureProvider = smtpProvider({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
    })

    expect(secureProvider.options!.port).toBe(465)
    expect(secureProvider.options!.secure).toBe(true)

    const insecureProvider = smtpProvider({
      host: 'smtp.example.com',
      port: 25,
    })

    expect(insecureProvider.options!.port).toBe(25)
  })

  it('should throw error if host is not provided', () => {
    expect(() => smtpProvider({} as any)).toThrow('[unemail] [smtp] Missing required option: \'host\'')
  })

  it('should check if SMTP server is available', async () => {
    const result = await provider.isAvailable()

    expect(result).toBe(true)
    expect(mockTransporter.verify).toHaveBeenCalled()
  })

  it('should return false if SMTP server is not available', async () => {
    mockTransporter.verify.mockRejectedValueOnce(new Error('Connection refused'))

    const result = await provider.isAvailable()

    expect(result).toBe(false)
    expect(mockTransporter.verify).toHaveBeenCalled()
  })

  it('should initialize the provider', async () => {
    await provider.initialize()

    expect(mockTransporter.verify).toHaveBeenCalled()
  })

  it('should throw error if SMTP server is not available during initialization', async () => {
    mockTransporter.verify.mockRejectedValueOnce(new Error('Connection refused'))

    await expect(provider.initialize()).rejects.toThrow('Failed to initialize')
  })

  it('should send an email via SMTP', async () => {
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

    // Verify the result structure
    expect(result.success).toBe(true)
    if (result.success && result.data) {
      expect(result.data.messageId).toBe('test-message-id@example.com')
      expect(result.data.sent).toBe(true)
      expect(result.data.provider).toBe('smtp')
    }

    // Verify nodemailer was called
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Test Sender" <test@example.com>',
        to: '"Test Recipient" <recipient@example.com>',
        subject: 'Test Email',
        text: 'This is a test email',
        html: '<p>This is a test email</p>',
      }),
    )
  })

  it('should validate email options before sending', async () => {
    // Import the validateEmailOptions function directly
    const utils = await import('unemail/utils')

    // Mock validateEmailOptions to return errors
    vi.mocked(utils.validateEmailOptions).mockReturnValueOnce(['subject is required', 'content is required'])

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

    // sendMail should not have been called
    expect(mockTransporter.sendMail).not.toHaveBeenCalled()
  })

  it('should handle SMTP errors during sending', async () => {
    // Mock sendMail to throw an error
    mockTransporter.sendMail.mockRejectedValueOnce(new Error('Connection refused'))

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    // Send email - should fail due to SMTP error
    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to send email')
  })

  it('should validate credentials successfully', async () => {
    // Create a provider with credentials
    const providerWithCredentials = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: {
        user: 'testuser',
        pass: 'testpass',
      },
    })

    // Call validateCredentials method
    const result = await providerWithCredentials.validateCredentials!()

    // Validation should succeed (uses isAvailable internally)
    expect(result).toBe(true)
    expect(mockTransporter.verify).toHaveBeenCalled()
  })

  it('should handle validateCredentials failure', async () => {
    mockTransporter.verify.mockRejectedValueOnce(new Error('Auth failed'))

    // Create a provider with credentials
    const providerWithCredentials = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      auth: {
        user: 'testuser',
        pass: 'testpass',
      },
    })

    // Call validateCredentials method
    const result = await providerWithCredentials.validateCredentials!()

    // Validation should fail
    expect(result).toBe(false)
  })

  it('should create a provider instance with advanced options', () => {
    const advancedProvider = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      tls: {
        rejectUnauthorized: false,
      },
      pool: true,
      maxConnections: 10,
      authMethod: 'CRAM-MD5',
      dkim: {
        domainName: 'example.com',
        keySelector: 'mail',
        privateKey: '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBg...\n-----END PRIVATE KEY-----',
      },
    })

    expect(advancedProvider.name).toBe('smtp')
    expect(advancedProvider.options!.tls?.rejectUnauthorized).toBe(false)
    expect(advancedProvider.options!.pool).toBe(true)
    expect(advancedProvider.options!.maxConnections).toBe(10)
    expect(advancedProvider.options!.authMethod).toBe('CRAM-MD5')
    expect(advancedProvider.options!.dkim).toBeDefined()
    expect(advancedProvider.options!.dkim!.domainName).toBe('example.com')
  })

  it('should use default values for advanced options if not provided', () => {
    expect(provider.options!.pool).toBeUndefined()
  })

  it('should send an email with special headers', async () => {
    // Create test email options with additional headers
    const emailOptions: SmtpEmailOptions = {
      from: { email: 'test@example.com', name: 'Test Sender' },
      to: { email: 'recipient@example.com', name: 'Test Recipient' },
      subject: 'Test Email',
      text: 'This is a test email',
      html: '<p>This is a test email</p>',
      inReplyTo: '<previous-message-id@example.com>',
      references: ['<ref1@example.com>', '<ref2@example.com>'],
      listUnsubscribe: 'mailto:unsubscribe@example.com',
    }

    // Send email
    const result = await provider.sendEmail(emailOptions)

    // Verify the result structure
    expect(result.success).toBe(true)

    // Verify sendMail was called with the correct options
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: '<previous-message-id@example.com>',
        references: ['<ref1@example.com>', '<ref2@example.com>'],
        list: {
          unsubscribe: 'mailto:unsubscribe@example.com',
        },
      }),
    )
  })

  it('should support extended authentication options', () => {
    const providerWithAuth = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      authMethod: 'OAUTH2',
      auth: {
        type: 'oauth2' as const,
        user: 'user@example.com',
        pass: '',
      },
    })

    expect(providerWithAuth.options!.authMethod).toBe('OAUTH2')
    expect(providerWithAuth.options!.auth).toBeDefined()
    expect(providerWithAuth.options!.auth!.user).toBe('user@example.com')
  })

  it('should have close method to properly clean up resources', async () => {
    // Cast to include close method which is SMTP-specific
    const smtpProviderWithClose = provider as typeof provider & { close: () => Promise<void> }

    // Check if close exists as a property on the provider object
    expect('close' in provider).toBe(true)
    expect(typeof smtpProviderWithClose.close).toBe('function')

    // First initialize to create transporter
    await provider.initialize()

    // Call close
    await smtpProviderWithClose.close()

    // Verify transporter.close was called
    expect(mockTransporter.close).toHaveBeenCalled()
  })

  it('should handle multiple recipients', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: [
        { email: 'recipient1@example.com', name: 'Recipient 1' },
        { email: 'recipient2@example.com', name: 'Recipient 2' },
      ],
      cc: { email: 'cc@example.com' },
      bcc: [{ email: 'bcc@example.com' }],
      subject: 'Test Email',
      text: 'This is a test email',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['"Recipient 1" <recipient1@example.com>', '"Recipient 2" <recipient2@example.com>'],
        cc: 'cc@example.com',
        bcc: ['bcc@example.com'],
      }),
    )
  })

  it('should handle attachments', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email with Attachment',
      text: 'This email has an attachment',
      attachments: [
        {
          filename: 'test.txt',
          content: Buffer.from('Test content'),
          contentType: 'text/plain',
        },
      ],
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            filename: 'test.txt',
            contentType: 'text/plain',
          }),
        ]),
      }),
    )
  })

  it('should handle DSN options', async () => {
    const emailOptions: SmtpEmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email with DSN',
      text: 'This email requests delivery status notification',
      dsn: {
        notify: ['success', 'failure', 'delay'],
      },
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: {
          notify: ['success', 'failure', 'delay'],
        },
      }),
    )
  })

  it('should handle priority option', async () => {
    const emailOptions: SmtpEmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'High Priority Email',
      text: 'This is a high priority email',
      priority: 'high',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 'high',
      }),
    )
  })
})
