import type { EmailOptions } from 'unemail/types'
import awsSesProvider from 'unemail/providers/aws-ses'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist the mock objects to be available during vi.mock
const { mockSend, MockSESClient } = vi.hoisted(() => {
  const mockSend = vi.fn()

  class MockSESClient {
    send = mockSend
    constructor(_config: any) {}
  }

  return { mockSend, MockSESClient }
})

// Mock @aws-sdk/client-ses
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: MockSESClient,
  SendRawEmailCommand: class SendRawEmailCommand {
    input: any
    type = 'SendRawEmailCommand'
    constructor(input: any) {
      this.input = input
    }
  },
  GetSendQuotaCommand: class GetSendQuotaCommand {
    type = 'GetSendQuotaCommand'
    constructor() {}
  },
}))

// Mock crypto module
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('mocked-uuid-v4'),
}))

// Mock the utility functions
vi.mock('unemail/utils', () => ({
  createError: (component: string, message: string) => new Error(`[unemail] [${component}] ${message}`),
  createRequiredError: (component: string, name: string) => new Error(`[unemail] [${component}] Missing required option: '${name}'`),
  validateEmailOptions: vi.fn().mockReturnValue([]),
}))

describe('aWS SES Provider', () => {
  let provider: ReturnType<typeof awsSesProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    // Reset mock implementations
    mockSend.mockReset()

    // Default mock for GetSendQuotaCommand
    mockSend.mockImplementation((command) => {
      if (command.type === 'GetSendQuotaCommand') {
        return Promise.resolve({
          Max24HourSend: 200,
          MaxSendRate: 10,
          SentLast24Hours: 0,
        })
      }
      if (command.type === 'SendRawEmailCommand') {
        return Promise.resolve({
          MessageId: 'test-message-id-123456',
        })
      }
      return Promise.resolve({})
    })

    // Create a fresh provider instance with test options
    provider = awsSesProvider({
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'test-key-id',
        secretAccessKey: 'test-secret-key',
      },
    })
  })

  it('should create a provider instance with correct defaults', () => {
    expect(provider.name).toBe('aws-ses')
    expect(provider.options!.region).toBe('us-east-1')
    const creds = provider.options!.credentials as { accessKeyId: string, secretAccessKey: string } | undefined
    expect(creds?.accessKeyId).toBe('test-key-id')
    expect(creds?.secretAccessKey).toBe('test-secret-key')
  })

  it('should throw error if region is not provided', () => {
    expect(() => awsSesProvider({} as any)).toThrow('[unemail] [aws-ses] Missing required option: \'region\'')
  })

  it('should check if AWS SES is available', async () => {
    const result = await provider.isAvailable()

    expect(result).toBe(true)
    expect(mockSend).toHaveBeenCalled()
  })

  it('should handle errors when checking availability', async () => {
    // Make the send fail
    mockSend.mockRejectedValueOnce(new Error('Connection failed'))

    const result = await provider.isAvailable()

    expect(result).toBe(false)
    expect(mockSend).toHaveBeenCalled()
  })

  it('should initialize the provider', async () => {
    await provider.initialize()

    // Should not throw an error
    expect(provider.options!.region).toBe('us-east-1')
  })

  it('should validate credentials successfully', async () => {
    const result = await provider.validateCredentials!()
    expect(result).toBe(true)
    expect(mockSend).toHaveBeenCalled()
  })

  it('should handle validateCredentials failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('Invalid credentials'))

    const result = await provider.validateCredentials!()
    expect(result).toBe(false)
  })

  it('should send an email via AWS SES', async () => {
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

    // Verify SES client was called
    expect(mockSend).toHaveBeenCalled()
  })

  it('should handle complex email addresses', async () => {
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
    expect(result.data?.messageId).toBe('test-message-id-123456')

    // Verify SES client was called
    expect(mockSend).toHaveBeenCalled()
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
  })

  it('should handle AWS SES errors during sending', async () => {
    // Make the send fail for SendRawEmailCommand
    mockSend.mockImplementation((command) => {
      if (command.type === 'GetSendQuotaCommand') {
        return Promise.resolve({
          Max24HourSend: 200,
        })
      }
      if (command.type === 'SendRawEmailCommand') {
        return Promise.reject(new Error('Email address is not verified'))
      }
      return Promise.resolve({})
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
  })

  it('should return getInstance that provides SES client', () => {
    const instance = provider.getInstance!()
    expect(instance).toBeInstanceOf(MockSESClient)
  })

  it('should send email with configuration set name', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
      configurationSetName: 'my-config-set',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockSend).toHaveBeenCalled()

    // Check that the SendRawEmailCommand was called with ConfigurationSetName
    const sendCall = mockSend.mock.calls.find(call => call[0]?.type === 'SendRawEmailCommand')
    expect(sendCall).toBeDefined()
    expect(sendCall![0].input.ConfigurationSetName).toBe('my-config-set')
  })

  it('should send email with message tags', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
      messageTags: {
        Environment: 'production',
        Application: 'unemail',
      },
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockSend).toHaveBeenCalled()

    // Check that the SendRawEmailCommand was called with Tags
    const sendCall = mockSend.mock.calls.find(call => call[0]?.type === 'SendRawEmailCommand')
    expect(sendCall).toBeDefined()
    expect(sendCall![0].input.Tags).toEqual([
      { Name: 'Environment', Value: 'production' },
      { Name: 'Application', Value: 'unemail' },
    ])
  })

  it('should send email with source ARN', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
      sourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/example.com',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockSend).toHaveBeenCalled()

    // Check that the SendRawEmailCommand was called with SourceArn
    const sendCall = mockSend.mock.calls.find(call => call[0]?.type === 'SendRawEmailCommand')
    expect(sendCall).toBeDefined()
    expect(sendCall![0].input.SourceArn).toBe('arn:aws:ses:us-east-1:123456789012:identity/example.com')
  })

  it('should send email with return path', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
      returnPath: 'bounce@example.com',
      returnPathArn: 'arn:aws:ses:us-east-1:123456789012:identity/bounce.example.com',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockSend).toHaveBeenCalled()

    // Check that the SendRawEmailCommand was called with Source and ReturnPathArn
    const sendCall = mockSend.mock.calls.find(call => call[0]?.type === 'SendRawEmailCommand')
    expect(sendCall).toBeDefined()
    expect(sendCall![0].input.Source).toBe('bounce@example.com')
    expect(sendCall![0].input.ReturnPathArn).toBe('arn:aws:ses:us-east-1:123456789012:identity/bounce.example.com')
  })

  it('should include custom headers in the email', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email with Headers',
      text: 'This is a test email',
      headers: {
        'X-Custom-Header': 'custom-value',
        'X-Application': 'unemail-test',
      },
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockSend).toHaveBeenCalled()
  })

  it('should handle only text content', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Text Only Email',
      text: 'This is a plain text email',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(result.data?.messageId).toBe('test-message-id-123456')
  })

  it('should handle only HTML content', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'HTML Only Email',
      html: '<p>This is an HTML email</p>',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(result.data?.messageId).toBe('test-message-id-123456')
  })
})
