import type { EmailOptions } from 'unemail/types'
import { Buffer } from 'node:buffer'
import httpProvider from 'unemail/providers/http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist the mock objects to be available during vi.mock
const { mockFetch, mockOfetchCreate } = vi.hoisted(() => {
  const mockFetch = vi.fn() as ReturnType<typeof vi.fn> & { raw: ReturnType<typeof vi.fn> }
  mockFetch.raw = vi.fn()
  const mockOfetchCreate = vi.fn(() => mockFetch)
  return { mockFetch, mockOfetchCreate }
})

// Mock ofetch package
vi.mock('ofetch', () => ({
  ofetch: {
    create: mockOfetchCreate,
  },
}))

// Mock the utility functions
vi.mock('unemail/utils', () => ({
  generateMessageId: () => '<test-message-id@unemail.local>',
  createError: (component: string, message: string) => new Error(`[unemail] [${component}] ${message}`),
  validateEmailOptions: vi.fn().mockReturnValue([]),
}))

describe('hTTP Provider', () => {
  let provider: ReturnType<typeof httpProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    // Reset mock implementations
    mockFetch.mockReset()
    mockFetch.raw.mockReset()

    // Default successful response
    mockFetch.mockResolvedValue({
      id: 'server-message-id',
      success: true,
    })
    mockFetch.raw.mockResolvedValue({
      status: 200,
      ok: true,
    })

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
    const result = await provider.isAvailable()

    expect(result).toBe(true)
    expect(mockFetch.raw).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        method: 'OPTIONS',
      }),
    )
  })

  it('should consider 4xx response as available (endpoint exists but auth required)', async () => {
    // Mock 401 Unauthorized response
    const error = new Error('Request failed') as Error & { status: number }
    error.status = 401
    mockFetch.raw.mockRejectedValueOnce(error)

    const result = await provider.isAvailable()

    expect(result).toBe(true) // API exists but needs auth
  })

  it('should consider 5xx response as unavailable', async () => {
    // Mock server error response
    const error = new Error('Request failed') as Error & { status: number }
    error.status = 500
    mockFetch.raw.mockRejectedValueOnce(error)

    const result = await provider.isAvailable()

    expect(result).toBe(false)
  })

  it('should consider network error as unavailable', async () => {
    // Mock network error (no status code)
    mockFetch.raw.mockRejectedValueOnce(new Error('Network error'))

    const result = await provider.isAvailable()

    expect(result).toBe(false)
  })

  it('should initialize successfully', async () => {
    await provider.initialize()

    // Should not throw an error
    expect(provider.options!.endpoint).toBe('https://api.example.com/email')
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
    expect(result.data?.provider).toBe('http')
    expect(result.data?.sent).toBe(true)

    // Verify ofetch was called
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          from: 'test@example.com',
          from_name: 'Test Sender',
          to: ['recipient1@example.com', 'recipient2@example.com'],
          subject: 'Test Email',
        }),
      }),
    )
  })

  it('should validate email options before sending', async () => {
    // Import the actual utils module to properly mock the function
    const utils = await import('unemail/utils')

    // Mock validateEmailOptions to return errors
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
    // Make sure no API request was made
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('should handle API errors during sending', async () => {
    // Mock failed API response
    mockFetch.mockRejectedValueOnce(new Error('Server Error'))

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
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce(testCase.response)

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
    const result = await provider.validateCredentials!()
    expect(result).toBe(true)
    expect(mockFetch.raw).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        method: 'GET',
      }),
    )
  })

  it('should handle failed credential validation', async () => {
    // Mock failed GET request for credential validation
    const error = new Error('Request failed') as Error & { status: number }
    error.status = 401
    mockFetch.raw.mockRejectedValueOnce(error)

    const result = await provider.validateCredentials!()
    expect(result).toBe(false)
  })

  it('should use endpoint override when provided', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
      endpointOverride: 'https://api.example.com/v2/email',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v2/email',
      expect.anything(),
    )
  })

  it('should use method override when provided', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
      methodOverride: 'PUT' as const,
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        method: 'PUT',
      }),
    )
  })

  it('should include custom params in the request', async () => {
    const emailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      subject: 'Test Email',
      text: 'This is a test email',
      customParams: {
        template_id: 'my-template',
        campaign_id: 'campaign-123',
      },
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        body: expect.objectContaining({
          template_id: 'my-template',
          campaign_id: 'campaign-123',
        }),
      }),
    )
  })

  it('should handle cc and bcc recipients', async () => {
    const emailOptions: EmailOptions = {
      from: { email: 'test@example.com' },
      to: { email: 'recipient@example.com' },
      cc: { email: 'cc@example.com' },
      bcc: [
        { email: 'bcc1@example.com' },
        { email: 'bcc2@example.com' },
      ],
      subject: 'Test Email',
      text: 'This is a test email',
    }

    const result = await provider.sendEmail(emailOptions)

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/email',
      expect.objectContaining({
        body: expect.objectContaining({
          cc: 'cc@example.com',
          bcc: ['bcc1@example.com', 'bcc2@example.com'],
        }),
      }),
    )
  })

  it('should return getInstance that provides fetch instance', () => {
    const instance = provider.getInstance!()
    expect(instance).toBe(mockFetch)
  })

  it('should use default values for optional options', () => {
    const minimalProvider = httpProvider({
      endpoint: 'https://api.example.com/email',
    })

    expect(minimalProvider.options!.method).toBe('POST')
    expect(minimalProvider.options!.timeout).toBe(30000)
    expect(minimalProvider.options!.retry).toBe(0)
    expect(minimalProvider.options!.headers).toEqual({})
  })
})
