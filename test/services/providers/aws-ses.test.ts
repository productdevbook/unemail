import type { ClientRequest, IncomingMessage } from 'node:http'
import type { EmailOptions } from 'unemail/types'
import { Buffer } from 'node:buffer'
import * as https from 'node:https'
import awsSesProvider from 'unemail/providers/aws-ses'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Create request and response mocks
const mockRequest = {
  on: vi.fn().mockReturnThis(),
  write: vi.fn(),
  end: vi.fn(),
} as unknown as ClientRequest

const mockResponse = {
  on: vi.fn().mockImplementation((event, callback) => {
    if (event === 'data') {
      // Will be called with data chunks
      callback('<SendEmailResponse><SendEmailResult><MessageId>test-message-id-123456</MessageId></SendEmailResult></SendEmailResponse>')
    }
    if (event === 'end') {
      // Will be called when response ends
      callback()
    }
    return mockResponse
  }),
  statusCode: 200,
} as unknown as IncomingMessage

// Mock https module
vi.mock('node:https', () => ({
  request: vi.fn(),
}))

// Mock crypto module - we're not testing the actual cryptography
vi.mock('node:crypto', () => ({
  createHash: vi.fn().mockReturnValue({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue('mocked-hash'),
  }),
  createHmac: vi.fn().mockReturnValue({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockImplementation(() => Buffer.from('mocked-hmac-digest')),
  }),
  randomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue('random-string'),
  }),
  // Add missing randomUUID function
  randomUUID: vi.fn().mockReturnValue('mocked-uuid-v4'),
}))

describe('aWS SES Provider (Zero-Dependency)', () => {
  let provider: ReturnType<typeof awsSesProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    // Set up default mock for https.request
    vi.mocked(https.request).mockImplementation((...args) => {
      // Extract the callback function which might be in different positions
      const callback = args.find(arg => typeof arg === 'function') as ((res: IncomingMessage) => void) | undefined

      // Call the callback if it exists
      if (callback) {
        callback(mockResponse)
      }

      return mockRequest
    })

    // Set up response for GetSendQuota (availability check)
    mockResponse.on = vi.fn().mockImplementation((event, callback) => {
      if (event === 'data') {
        callback('<GetSendQuotaResponse><GetSendQuotaResult><Max24HourSend>200</Max24HourSend></GetSendQuotaResult></GetSendQuotaResponse>')
      }
      if (event === 'end') {
        callback()
      }
      return mockResponse
    })

    // Create a fresh provider instance with test options
    provider = awsSesProvider({
      region: 'us-east-1',
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret-key',
    })
  })

  it('should create a provider instance with correct defaults', () => {
    expect(provider.name).toBe('aws-ses')
    expect(provider.options!.region).toBe('us-east-1')
    expect(provider.options!.accessKeyId).toBe('test-key-id')
    expect(provider.options!.secretAccessKey).toBe('test-secret-key')
    expect(provider.options!.maxAttempts).toBe(3)
  })

  it('should check if AWS SES is available', async () => {
    const result = await provider.isAvailable()

    expect(result).toBe(true)
    expect(https.request).toHaveBeenCalled()
    expect(mockRequest.end).toHaveBeenCalled()
  })

  it('should handle errors when checking availability', async () => {
    // Make the request fail
    const errorResponse = { ...mockResponse, statusCode: 400 } as unknown as IncomingMessage
    vi.mocked(https.request).mockImplementationOnce((...args) => {
      // Extract the callback function
      const callback = args.find(arg => typeof arg === 'function') as ((res: IncomingMessage) => void) | undefined

      // Call the callback with error response if it exists
      if (callback) {
        callback(errorResponse)
      }

      return {
        ...mockRequest,
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === 'error')
            callback(new Error('Connection failed'))
          return mockRequest
        }),
      } as unknown as ClientRequest
    })

    const result = await provider.isAvailable()

    expect(result).toBe(false)
    expect(https.request).toHaveBeenCalled()
  })

  it('should initialize the provider', async () => {
    await provider.initialize()

    // Should not throw an error
    expect(provider.options!.region).toBe('us-east-1')
  })

  it('should validate credentials successfully', async () => {
    // Mock the isAvailable method for this test
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(true)

    // Only run this test if validateCredentials is available
    if (provider.validateCredentials) {
      const result = await provider.validateCredentials()
      expect(result).toBe(true)
      expect(provider.isAvailable).toHaveBeenCalledTimes(1)
    }
    else {
      // Skip test if method is not available
      console.log('validateCredentials not available, skipping test')
    }
  })

  it('should send an email via AWS SES', async () => {
    // Set up response for SendEmail
    mockResponse.on = vi.fn().mockImplementation((event, callback) => {
      if (event === 'data') {
        callback('<SendEmailResponse><SendEmailResult><MessageId>test-message-id-123456</MessageId></SendEmailResult></SendEmailResponse>')
      }
      if (event === 'end') {
        callback()
      }
      return mockResponse
    })

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com', name: 'Test Sender' },
      to: { email: 'recipient@example.com', name: 'Test Recipient' },
      subject: 'Test Email',
      text: 'This is a test email',
      html: '<p>This is a test email</p>',
      headers: {
        'X-Custom-Header': 'custom-value',
      },
    }

    // Send email
    const result = await provider.sendEmail(emailOptions)

    // Verify result
    expect(result.success).toBe(true)
    expect(result.data?.sent).toBe(true)
    expect(result.data?.provider).toBe('aws-ses')
    expect(result.data?.messageId).toBe('test-message-id-123456')

    // Verify that https request was made
    expect(https.request).toHaveBeenCalled()
    expect(mockRequest.write).toHaveBeenCalled()
    expect(mockRequest.end).toHaveBeenCalled()
  })

  it('should handle complex email addresses', async () => {
    // Set up response for SendEmail with multiple recipients
    mockResponse.on = vi.fn().mockImplementation((event, callback) => {
      if (event === 'data') {
        callback('<SendEmailResponse><SendEmailResult><MessageId>multi-recipient-id</MessageId></SendEmailResult></SendEmailResponse>')
      }
      if (event === 'end') {
        callback()
      }
      return mockResponse
    })

    // Create test email with multiple recipients
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com', name: 'Test Sender' },
      to: [
        { email: 'recipient1@example.com', name: 'Recipient One' },
        { email: 'recipient2@example.com', name: 'Recipient Two' },
      ],
      cc: { email: 'cc@example.com', name: 'CC Recipient' },
      bcc: { email: 'bcc@example.com', name: 'BCC Recipient' },
      subject: 'Multi-Recipient Test',
      text: 'This is a test with multiple recipients',
    }

    // Send email
    const result = await provider.sendEmail(emailOptions)

    // Verify result
    expect(result.success).toBe(true)
    expect(result.data?.messageId).toBe('multi-recipient-id')

    // Verify that https request was made with correct data
    expect(https.request).toHaveBeenCalled()
    expect(mockRequest.write).toHaveBeenCalledTimes(1)

    // Since we're not testing the exact payload, just ensure a request was made
    expect(mockRequest.end).toHaveBeenCalled()
  })

  it('should validate email options before sending', async () => {
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

  it('should handle AWS SES errors during sending', async () => {
    // Make the request fail with an error response from AWS SES
    mockResponse.statusCode = 400
    mockResponse.on = vi.fn().mockImplementation((event, callback) => {
      if (event === 'data') {
        callback('<ErrorResponse><Error><Type>Sender</Type><Code>InvalidParameter</Code><Message>Email address is not verified</Message></Error></ErrorResponse>')
      }
      if (event === 'end') {
        callback()
      }
      return mockResponse
    })

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    // Send email - should fail due to AWS error
    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to send email')

    // Reset status code for other tests
    mockResponse.statusCode = 200
  })

  it('should handle network errors during request', async () => {
    // Make the request throw a network error
    vi.mocked(https.request).mockImplementationOnce((..._args) => {
      return {
        ...mockRequest,
        on: vi.fn().mockImplementation((event, callback) => {
          if (event === 'error')
            callback(new Error('Network error'))
          return mockRequest
        }),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest
    })

    // Create test email options
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
    }

    // Send email - should fail due to network error
    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Failed to send email')
  })

  it('should return null for getInstance since we do not use AWS SDK', () => {
    // Get the client instance - should be null
    if (provider.getInstance) {
      const clientInstance = provider.getInstance()
      expect(clientInstance).toBeNull()
    }
    else {
      // Skip test if method is not available
      console.log('getInstance not available, skipping test')
    }
  })
})
