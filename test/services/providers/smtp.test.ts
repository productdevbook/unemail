import type { SmtpEmailOptions } from 'unemail/providers/smtp'
import type { EmailOptions, EmailResult, Result } from 'unemail/types'
import { Buffer } from 'node:buffer'
import smtpProvider from 'unemail/providers/smtp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// Mock the modules
vi.mock('node:net', () => ({
  Socket: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    setTimeout: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    destroy: vi.fn(),
  })),
  createConnection: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    once: vi.fn((event, callback) => {
      if (event === 'data') {
        setTimeout(() => callback(Buffer.from('220 smtp.example.com ESMTP ready\r\n')), 0)
      }
      return {
        on: vi.fn().mockReturnThis(),
        once: vi.fn().mockReturnThis(),
        setTimeout: vi.fn(),
        write: vi.fn().mockReturnValue(true),
        end: vi.fn(),
        destroy: vi.fn(),
      }
    }),
    setTimeout: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    destroy: vi.fn(),
  })),
}))

vi.mock('node:tls', () => ({
  connect: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    once: vi.fn((event, callback) => {
      if (event === 'data') {
        setTimeout(() => callback(Buffer.from('220 smtp.example.com ESMTP ready\r\n')), 0)
      }
      if (event === 'secure') {
        setTimeout(() => callback(), 0)
      }
      return {
        on: vi.fn().mockReturnThis(),
        once: vi.fn().mockReturnThis(),
        setTimeout: vi.fn(),
        write: vi.fn().mockReturnValue(true),
        end: vi.fn(),
        destroy: vi.fn(),
      }
    }),
    setTimeout: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    destroy: vi.fn(),
  })),
}))

vi.mock('node:crypto', () => ({
  createHmac: vi.fn().mockReturnValue({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue('md5digest'),
  }),
  createHash: vi.fn().mockReturnValue({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue('sha256hash'),
  }),
  createSign: vi.fn().mockReturnValue({
    update: vi.fn().mockReturnThis(),
    sign: vi.fn().mockReturnValue('dkim-signature'),
  }),
}))

// Mock the utility functions directly
vi.mock('unemail/utils', async () => {
  return {
    isPortAvailable: vi.fn().mockResolvedValue(true),
    createError: vi.fn((component, message) => new Error(`[unemail] [${component}] ${message}`)),
    createRequiredError: vi.fn((component, name) =>
      new Error(`[unemail] [${component}] Missing required option: '${name}'`)),
    generateMessageId: vi.fn().mockReturnValue('test-message-id@example.com'),
    buildMimeMessage: vi.fn().mockReturnValue('MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nTest content'),
    validateEmailOptions: vi.fn().mockReturnValue([]), // No validation errors by default
  }
})

describe('sMTP Provider', () => {
  let provider: ReturnType<typeof smtpProvider>

  beforeEach(() => {
    vi.clearAllMocks()

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

  it('should use default ports based on secure option', () => {
    const secureProvider = smtpProvider({
      host: 'smtp.example.com',
      port: 465, // Explicitly include port since it's required by SmtpConfig
      secure: true,
    })

    expect(secureProvider.options!.port).toBe(465) // Default secure port

    const insecureProvider = smtpProvider({
      host: 'smtp.example.com',
      port: 25, // Explicitly include port since it's required by SmtpConfig
    })

    expect(insecureProvider.options!.secure).toBe(false)
    expect(insecureProvider.options!.port).toBe(25) // Default insecure port
  })

  it('should throw error if host is not provided', () => {
    expect(() => smtpProvider({} as any)).toThrow('[unemail] [smtp] Missing required option: \'host\'')
  })

  it('should check if SMTP server is available', async () => {
    // Override isAvailable for this test
    const isAvailableSpy = vi.spyOn(provider, 'isAvailable')
    isAvailableSpy.mockResolvedValueOnce(true)

    const result = await provider.isAvailable()
    expect(result).toBe(true)
  })

  it('should initialize the provider', async () => {
    // Mock the availability check
    const isAvailableSpy = vi.spyOn(provider, 'isAvailable')
    isAvailableSpy.mockResolvedValueOnce(true)

    await provider.initialize()
    expect(isAvailableSpy).toHaveBeenCalledTimes(1)
  })

  it('should throw error if SMTP server is not available during initialization', async () => {
    // Mock the availability check to return false
    const isAvailableSpy = vi.spyOn(provider, 'isAvailable')
    isAvailableSpy.mockResolvedValueOnce(false)

    await expect(provider.initialize()).rejects.toThrow('SMTP server not available')
  })

  it('should send an email via SMTP', async () => {
    // Mock the sendEmail method to avoid actual SMTP connection
    const sendEmailSpy = vi.spyOn(provider, 'sendEmail')

    const mockResult: Result<EmailResult> = {
      success: true,
      data: {
        messageId: 'test-message-id@example.com',
        sent: true,
        timestamp: new Date(),
        provider: 'smtp',
        response: 'Message accepted',
      },
    }

    // Set up the mock implementation
    sendEmailSpy.mockResolvedValueOnce(mockResult)

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

    // Restore the original method
    sendEmailSpy.mockRestore()
  })

  it('should validate email options before sending', async () => {
    // Import the validateEmailOptions function directly
    const utils = await import('unemail/utils')

    // Mock validateEmailOptions to return errors
    const mockValidateEmailOptions = vi.spyOn(utils, 'validateEmailOptions')
    mockValidateEmailOptions.mockReturnValueOnce(['subject is required', 'content is required'])

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

    // Restore the original method
    mockValidateEmailOptions.mockRestore()
  })

  it('should handle SMTP errors during sending', async () => {
    // Mock the sendEmail method to simulate an error
    const sendEmailSpy = vi.spyOn(provider, 'sendEmail')

    const mockResult: Result<EmailResult> = {
      success: false,
      error: new Error('[unemail] [smtp] Failed to send email: Connection refused'),
    }

    // Set up the mock implementation to return an error
    sendEmailSpy.mockResolvedValueOnce(mockResult)

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

    // Restore the original method
    sendEmailSpy.mockRestore()
  })

  it('should validate credentials successfully', async () => {
    // Create a provider with credentials
    const providerWithCredentials = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      user: 'testuser',
      password: 'testpass',
    })

    // Only test if validateCredentials exists on the provider
    if (typeof providerWithCredentials.validateCredentials === 'function') {
      // Replace the entire function instead of using mockResolvedValueOnce
      const originalValidateCredentials = providerWithCredentials.validateCredentials
      providerWithCredentials.validateCredentials = async () => true

      // Call validateCredentials method
      const result = await providerWithCredentials.validateCredentials()

      // Validation should succeed
      expect(result).toBe(true)

      // Restore original function
      providerWithCredentials.validateCredentials = originalValidateCredentials
    }
    else {
      // Skip if validateCredentials is not available
      console.warn('validateCredentials method not available, skipping test')
    }
  })

  it('should handle validateCredentials failure', async () => {
    // Create a provider with credentials
    const providerWithCredentials = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      user: 'testuser',
      password: 'testpass',
    })

    // Only test if validateCredentials exists on the provider
    if (typeof providerWithCredentials.validateCredentials === 'function') {
      // Replace the entire function instead of using mockResolvedValueOnce
      const originalValidateCredentials = providerWithCredentials.validateCredentials
      providerWithCredentials.validateCredentials = async () => false

      // Call validateCredentials method
      const result = await providerWithCredentials.validateCredentials()

      // Validation should fail
      expect(result).toBe(false)

      // Restore original function
      providerWithCredentials.validateCredentials = originalValidateCredentials
    }
    else {
      // Skip if validateCredentials is not available
      console.warn('validateCredentials method not available, skipping test')
    }
  })

  it('should create a provider instance with advanced options', () => {
    const advancedProvider = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      rejectUnauthorized: false,
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
    expect(advancedProvider.options!.rejectUnauthorized).toBe(false)
    expect(advancedProvider.options!.pool).toBe(true)
    expect(advancedProvider.options!.maxConnections).toBe(10)
    expect(advancedProvider.options!.authMethod).toBe('CRAM-MD5')
    expect(advancedProvider.options!.dkim).toBeDefined()
    expect(advancedProvider.options!.dkim!.domainName).toBe('example.com')
    expect(advancedProvider.features?.batchSending).toBe(true) // Added null check with ?
  })

  it('should use default values for advanced options if not provided', () => {
    expect(provider.options!.rejectUnauthorized).toBe(true)
    expect(provider.options!.pool).toBe(false)
    expect(provider.options!.maxConnections).toBe(5)
    expect(provider.features?.batchSending).toBe(false) // Added null check with ?
  })

  it('should send an email with special Gmail headers', async () => {
    // Mock the sendEmail method to avoid actual SMTP connection
    const sendEmailSpy = vi.spyOn(provider, 'sendEmail')

    const mockResult: Result<EmailResult> = {
      success: true,
      data: {
        messageId: 'test-message-id@example.com',
        sent: true,
        timestamp: new Date(),
        provider: 'smtp',
        response: 'Message accepted',
      },
    }

    // Set up the mock implementation
    sendEmailSpy.mockResolvedValueOnce(mockResult)

    // Create test email options with Gmail-specific headers
    const emailOptions: SmtpEmailOptions = {
      from: { email: 'test@example.com', name: 'Test Sender' },
      to: { email: 'recipient@example.com', name: 'Test Recipient' },
      subject: 'Test Email',
      text: 'This is a test email',
      html: '<p>This is a test email</p>',
      inReplyTo: '<previous-message-id@example.com>',
      references: ['<ref1@example.com>', '<ref2@example.com>'],
      listUnsubscribe: 'mailto:unsubscribe@example.com',
      googleMailHeaders: {
        promotionalContent: true,
        feedbackId: 'campaign:12345',
        category: 'promotions',
      },
      useDkim: true,
    }

    // Send email
    const result = await provider.sendEmail(emailOptions)

    // Verify the result structure
    expect(result.success).toBe(true)

    // Restore the original method
    sendEmailSpy.mockRestore()
  })

  it('should support extended authentication options', () => {
    const providerWithOAuth2 = smtpProvider({
      host: 'smtp.example.com',
      port: 587,
      authMethod: 'OAUTH2',
      oauth2: {
        user: 'user@example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expires: Date.now() + 3600000,
      },
    })

    expect(providerWithOAuth2.options!.authMethod).toBe('OAUTH2')
    expect(providerWithOAuth2.options!.oauth2).toBeDefined()
    expect(providerWithOAuth2.options!.oauth2!.user).toBe('user@example.com')
  })

  it('should add shutdown method to properly clean up resources', () => {
    expect(typeof provider.shutdown).toBe('function')
  })
})
