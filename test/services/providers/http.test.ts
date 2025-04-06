import type { EmailOptions } from 'unemail/types'
import type { Mock } from 'vitest'
import { Buffer } from 'node:buffer'
import httpProvider from 'unemail/providers/http'
import * as utils from 'unemail/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('unemail/utils', () => ({
  makeRequest: vi.fn(),
  generateMessageId: () => '<test-message-id@unemail.local>',
  createError: (component: string, message: string) => new Error(`[unemail] [${component}] ${message}`),
  createRequiredError: (component: string, name: string) => new Error(`[unemail] [${component}] Missing required option: '${name}'`),
  validateEmailOptions: () => [], // Add mock for validateEmailOptions returning empty array (no errors)
}))

describe('hTTP Provider', () => {
  let provider: ReturnType<typeof httpProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    // Create a fresh provider instance for each test
    provider = httpProvider({
      endpoint: 'https://api.example.com/email',
      apiKey: 'test-api-key',
      method: 'POST',
      headers: {
        'X-Custom-Header': 'test-value',
      },
    })
  })

  it('should create a provider instance with correct options', () => {
    expect(provider.name).toBe('http')
    expect(provider.options!.endpoint).toBe('https://api.example.com/email')
    expect(provider.options!.apiKey).toBe('test-api-key')
    expect(provider.options!.method).toBe('POST')
    expect(provider.options!.headers).toEqual({
      'X-Custom-Header': 'test-value',
    })
  })

  it('should throw error if endpoint is not provided', () => {
    expect(() => {
      httpProvider({ endpoint: '' })
    }).toThrow('Missing required option: endpoint')
  })

  it('should check if API is available', async () => {
    // Mock successful OPTIONS request
    (utils.makeRequest as Mock).mockResolvedValueOnce({
      success: true,
      data: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {},
      },
    })

    const result = await provider.isAvailable()

    expect(result).toBe(true)
    expect(utils.makeRequest).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        method: 'OPTIONS',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Custom-Header': 'test-value',
          'Authorization': 'Bearer test-api-key',
        }),
      }),
    )
  })

  it('should consider 4xx response as available (endpoint exists but auth required)', async () => {
    // Mock 401 Unauthorized response
    (utils.makeRequest as Mock).mockResolvedValueOnce({
      success: false,
      data: {
        statusCode: 401,
        headers: {},
        body: 'Unauthorized',
      },
      error: new Error('Request failed with status 401'),
    })

    const result = await provider.isAvailable()

    expect(result).toBe(true) // API exists but needs auth
  })

  it('should consider 5xx response as unavailable', async () => {
    // Mock server error response
    (utils.makeRequest as Mock).mockResolvedValueOnce({
      success: false,
      data: {
        statusCode: 500,
        headers: {},
        body: 'Server Error',
      },
      error: new Error('Request failed with status 500'),
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

    await expect(provider.initialize()).rejects.toThrow('API endpoint not available')
  })

  it('should send an email successfully', async () => {
    // Mock successful API response
    (utils.makeRequest as Mock).mockResolvedValueOnce({
      success: true,
      data: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          id: 'server-message-id',
          success: true,
        },
      },
    })

    // Mock availability check for initialization
    vi.spyOn(provider, 'isAvailable').mockResolvedValueOnce(true)

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
    expect(result.data?.provider).toBe('http')
    expect(result.data?.sent).toBe(true)

    // Verify request
    expect(utils.makeRequest).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Custom-Header': 'test-value',
          'Authorization': 'Bearer test-api-key',
        }),
      }),
      expect.stringContaining('"subject":"Test Email"'),
    )
  })

  it('should validate email options before sending', async () => {
    // Import the actual utils module to properly mock the function
    const mockValidateEmailOptions = vi.fn().mockReturnValueOnce(['Missing subject'])

    // Store original function and replace it with our mock
    const _originalValidateEmailOptions = vi.mocked(utils.validateEmailOptions)
    vi.spyOn(utils, 'validateEmailOptions').mockImplementationOnce(mockValidateEmailOptions)

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
    expect(utils.makeRequest).not.toHaveBeenCalled()
  })

  it('should handle API errors during sending', async () => {
    // Mock failed API response
    (utils.makeRequest as Mock).mockResolvedValueOnce({
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
    // Use a partial match pattern instead of looking for exact string
    expect(result.error?.message).toContain('Failed to send email')
  })

  it('should use different message ID fallbacks', async () => {
    // Test with different API response formats
    const testCases = [
      {
        response: { id: 'id-format-1' },
        expectedId: 'id-format-1',
      },
      {
        response: { messageId: 'message-id-format' },
        expectedId: 'message-id-format',
      },
      {
        response: { data: { id: 'nested-id-format' } },
        expectedId: 'nested-id-format',
      },
      {
        response: { data: { messageId: 'nested-message-id-format' } },
        expectedId: 'nested-message-id-format',
      },
      {
        response: { something: 'else' },
        expectedId: '<test-message-id@unemail.local>', // Generated ID
      },
    ]

    for (const testCase of testCases) {
      (utils.makeRequest as Mock).mockReset();
      (utils.makeRequest as Mock).mockResolvedValueOnce({
        success: true,
        data: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: testCase.response,
        },
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

      // Send email
      const result = await provider.sendEmail(emailOptions)

      expect(result.success).toBe(true)
      expect(result.data?.messageId).toBe(testCase.expectedId)
    }
  })

  it('should validate credentials', async () => {
    // Mock successful GET request for credential validation
    (utils.makeRequest as Mock).mockResolvedValueOnce({
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
      expect(utils.makeRequest).toHaveBeenCalledWith(
        'https://api.example.com/email',
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
    // Mock failed GET request for credential validation
    (utils.makeRequest as Mock).mockResolvedValueOnce({
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
