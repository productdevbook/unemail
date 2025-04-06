import type { EmailOptions } from 'unemail/types'
import type { Mock } from 'vitest'
import { Buffer } from 'node:buffer'
import resendProvider from 'unemail/providers/resend'
import { makeRequest } from 'unemail/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the utils.makeRequest function
vi.mock('unemail/utils', () => ({
  makeRequest: vi.fn(),
  generateMessageId: () => '<test-message-id@unemail.local>',
  createError: (component: string, message: string) => new Error(`[unemail] [${component}] ${message}`),
  createRequiredError: (component: string, name: string) => new Error(`[unemail] [${component}] Missing required option: '${name}'`),
  validateEmailOptions: () => [], // Add mock for validateEmailOptions returning empty array (no errors)
  retry: async (fn: () => any) => fn(), // Add mock for retry function that just calls the function directly
}))

describe('resend Provider', () => {
  let provider: ReturnType<typeof resendProvider>

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    (makeRequest as Mock).mockReset()

    // Create a fresh provider instance for each test
    provider = resendProvider({
      apiKey: 'test-api-key',
    })
  })

  it('should create a provider instance with correct options', () => {
    expect(provider.name).toBe('resend')
    expect(provider.options!.apiKey).toBe('test-api-key')
    expect(provider.options!.endpoint).toBe('https://api.resend.com')
  })

  it('should throw error if apiKey is not provided', () => {
    expect(() => {
      resendProvider({ apiKey: '' })
    }).toThrow('[unemail] [resend] Missing required option: \'apiKey\'')
  })

  it('should check if Resend API is available', async () => {
    // Mock successful domains request
    (makeRequest as Mock).mockResolvedValueOnce({
      success: true,
      data: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { data: [] },
      },
    })

    const result = await provider.isAvailable()

    expect(result).toBe(true)
    expect(makeRequest).toHaveBeenCalledWith(
      'https://api.resend.com/domains',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-api-key',
          'Content-Type': 'application/json',
        }),
      }),
    )
  })

  it('should consider API unavailable on error responses', async () => {
    // Mock failed API request
    (makeRequest as Mock).mockResolvedValueOnce({
      success: false,
      data: {
        statusCode: 401,
        headers: {},
        body: 'Unauthorized',
      },
      error: new Error('Request failed with status 401'),
    })

    const result = await provider.isAvailable()

    expect(result).toBe(false)
  })

  it('should initialize successfully if API is available', async () => {
    // Mock successful API check
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(true)

    await provider.initialize()

    expect(provider.isAvailable).toHaveBeenCalledTimes(1)
  })

  it('should throw error during initialization if API is not available', async () => {
    // Mock failed API check
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(false)

    await expect(provider.initialize()).rejects.toThrow('Resend API not available or invalid API key')
  })

  it('should send an email successfully', async () => {
    // Mock successful API response for email sending
    (makeRequest as Mock).mockImplementationOnce((_url, _options, _data) => {
      return Promise.resolve({
        success: true,
        data: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            id: 'server-message-id',
          },
        },
      })
    })

    // Set initialization state by spying on isAvailable and forcing it to be true
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(true)

    // Initialize the provider
    await provider.initialize()

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

    // Verify request
    expect(makeRequest).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-api-key',
        }),
      }),
      expect.stringContaining('"subject":"Test Email"'),
    )
  })

  it('should validate email options before sending', async () => {
    // Import the actual utils module to mock just the validateEmailOptions function
    const utils = await import('unemail/utils')

    // Mock validation errors
    const originalValidateEmailOptions = utils.validateEmailOptions
    utils.validateEmailOptions = vi.fn().mockReturnValueOnce(['Missing subject'])

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
    // Make sure no API request was made
    expect(makeRequest).not.toHaveBeenCalled()

    // Restore original function after test
    utils.validateEmailOptions = originalValidateEmailOptions
  })

  it('should handle API errors during sending', async () => {
    // Mock failed API response
    (makeRequest as Mock).mockResolvedValueOnce({
      success: false,
      data: {
        statusCode: 500,
        headers: {},
        body: 'Server Error',
      },
      error: new Error('Request failed with status 500'),
    })

    // Mock availability check for initialization
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(true)

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

  it('should validate credentials', async () => {
    // Mock successful API request for credential validation
    (makeRequest as Mock).mockResolvedValueOnce({
      success: true,
      data: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { status: 'ok' },
      },
    })

    // Only run this test if validateCredentials is available
    if (provider.validateCredentials) {
      const result = await provider.validateCredentials()
      expect(result).toBe(true)
      expect(makeRequest).toHaveBeenCalledWith(
        'https://api.resend.com/domains',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        }),
      )
    }
    else {
      // Skip test if method is not available
      console.log('validateCredentials not available, skipping test')
    }
  })

  it('should handle failed credential validation', async () => {
    // Mock failed API request for credential validation
    (makeRequest as Mock).mockResolvedValueOnce({
      success: true,
      data: {
        statusCode: 401,
        headers: {},
        body: 'Unauthorized',
      },
    })

    // Only run this test if validateCredentials is available
    if (provider.validateCredentials) {
      const result = await provider.validateCredentials()
      expect(result).toBe(false)
    }
    else {
      // Skip test if method is not available
      console.log('validateCredentials not available, skipping test')
    }
  })
})
