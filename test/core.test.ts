import type { EmailOptions } from 'unemail/types'
import { createEmailService, EmailService } from 'unemail'
import smtpProvider from 'unemail/providers/smtp'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock provider for testing
const mockSendEmail = vi.fn()
const mockIsAvailable = vi.fn()
const mockValidateCredentials = vi.fn()
const mockInitialize = vi.fn()

// Mock the smtp provider
vi.mock('unemail/providers/smtp', () => ({
  default: () => ({
    name: 'smtp-mock',
    features: {
      attachments: true,
      html: true,
    },
    options: { host: 'localhost', port: 1025 },
    initialize: mockInitialize,
    isAvailable: mockIsAvailable,
    sendEmail: mockSendEmail,
    validateCredentials: mockValidateCredentials,
  }),
}))

describe('emailService', () => {
  let emailService: EmailService

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks()

    // Create a fresh email service with the provider factory
    emailService = createEmailService({
      provider: smtpProvider,
      debug: true,
    })
  })

  it('should create an email service instance', () => {
    expect(emailService).toBeInstanceOf(EmailService)
  })

  it('should initialize the email service', async () => {
    mockInitialize.mockResolvedValueOnce(undefined)

    await emailService.initialize()

    expect(mockInitialize).toHaveBeenCalledTimes(1)
  })

  it('should check if provider is available', async () => {
    mockIsAvailable.mockResolvedValueOnce(true)

    const result = await emailService.isAvailable()

    expect(mockIsAvailable).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })

  it('should validate credentials', async () => {
    mockValidateCredentials.mockResolvedValueOnce(true)
    mockInitialize.mockResolvedValueOnce(undefined)

    const result = await emailService.validateCredentials()

    expect(mockInitialize).toHaveBeenCalledTimes(1)
    expect(mockValidateCredentials).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })

  it('should send email', async () => {
    const mockResult = {
      success: true,
      data: {
        messageId: 'test-id',
        sent: true,
        timestamp: new Date(),
        provider: 'smtp-mock',
      },
    }

    mockInitialize.mockResolvedValueOnce(undefined)
    mockSendEmail.mockResolvedValueOnce(mockResult)

    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com', name: 'Test Sender' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    const result = await emailService.sendEmail(emailOptions)

    expect(mockInitialize).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledWith(emailOptions)
    expect(result.success).toBe(true)
    expect(result.data?.messageId).toBe('test-id')
  })

  it('should handle errors during email sending', async () => {
    const mockError = new Error('Test error')

    mockInitialize.mockResolvedValueOnce(undefined)
    mockSendEmail.mockRejectedValueOnce(mockError)

    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    const result = await emailService.sendEmail(emailOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to send email')
  })
})
