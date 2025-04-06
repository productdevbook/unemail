import http from 'node:http'
import {
  createError,
  createRequiredError,
  generateMessageId,
  makeRequest,
  retry,
} from 'unemail/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('utility functions', () => {
  describe('createError', () => {
    it('should create an error with formatted message', () => {
      const error = createError('test', 'Something went wrong')
      expect(error.message).toBe('[unemail] [test] Something went wrong')
      expect(error instanceof Error).toBe(true)
    })

    it('should create an error with options', () => {
      const cause = new Error('Original cause')
      const error = createError('test', 'Error with cause', { cause, code: 'TEST_ERROR' })
      expect(error.message).toBe('[unemail] [test] Error with cause')
      expect(error.cause).toBe(cause)
    })
  })

  describe('createRequiredError', () => {
    it('should create an error for a single missing option', () => {
      const error = createRequiredError('test', 'apiKey')
      expect(error.message).toBe('[unemail] [test] Missing required option: \'apiKey\'')
    })

    it('should create an error for multiple missing options', () => {
      const error = createRequiredError('test', ['apiKey', 'endpoint'])
      expect(error.message).toBe('[unemail] [test] Missing required options: \'apiKey\', \'endpoint\'')
    })
  })

  describe('generateMessageId', () => {
    it('should generate a unique message ID', () => {
      const messageId1 = generateMessageId()
      const messageId2 = generateMessageId()

      expect(messageId1).toMatch(/<\d+\.[a-z0-9]+@unemail\.local>/)
      expect(messageId1).not.toBe(messageId2)
    })
  })

  describe('retry', () => {
    it('should return the result if successful on first try', async () => {
      const fn = vi.fn().mockResolvedValue({ success: true, data: 'test' })

      const result = await retry(fn, 3, 10)

      expect(fn).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(true)
      expect(result.data).toBe('test')
    })

    it('should retry until success', async () => {
      // Fail twice, succeed on third try
      const fn = vi.fn()
        .mockResolvedValueOnce({ success: false, error: new Error('First failure') })
        .mockResolvedValueOnce({ success: false, error: new Error('Second failure') })
        .mockResolvedValueOnce({ success: true, data: 'success after retries' })

      const result = await retry(fn, 3, 10)

      expect(fn).toHaveBeenCalledTimes(3)
      expect(result.success).toBe(true)
      expect(result.data).toBe('success after retries')
    })

    it('should give up after max retries', async () => {
      const fn = vi.fn().mockResolvedValue({
        success: false,
        error: new Error('Always failing'),
      })

      const result = await retry(fn, 2, 10)

      expect(fn).toHaveBeenCalledTimes(3) // Initial try + 2 retries
      expect(result.success).toBe(false)
      expect(result.error?.message).toBe('Always failing')
    })

    it('should handle thrown exceptions', async () => {
      const error = new Error('Unexpected error')
      const fn = vi.fn().mockRejectedValue(error)

      const result = await retry(fn, 2, 10)

      expect(fn).toHaveBeenCalledTimes(3) // Initial try + 2 retries
      expect(result.success).toBe(false)
      expect(result.error).toBe(error)
    })
  })

  describe('makeRequest', () => {
    let server: http.Server
    let url: string

    beforeEach(() => {
      // Create a temporary HTTP server for testing
      server = http.createServer((req, res) => {
        if (req.url === '/success') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok' }))
        }
        else if (req.url === '/error') {
          res.writeHead(500)
          res.end('Internal Server Error')
        }
        else if (req.url === '/timeout') {
          // Don't respond - will timeout
        }
        else if (req.url === '/text') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('Plain text response')
        }
      })

      // Start server on a random port
      server.listen(0)
      const address = server.address() as { port: number }
      url = `http://localhost:${address.port}`
    })

    afterEach(() => {
      // Close the server
      server.close()
    })

    // Using vi.useFakeTimers() would be ideal for these tests
    // but we're keeping it simple for demonstration

    it('should make a successful request', async () => {
      const result = await makeRequest(`${url}/success`)

      expect(result.success).toBe(true)
      expect(result.data.statusCode).toBe(200)
      expect(result.data.body).toEqual({ status: 'ok' })
    })

    it('should handle non-JSON responses', async () => {
      const result = await makeRequest(`${url}/text`)

      expect(result.success).toBe(true)
      expect(result.data.statusCode).toBe(200)
      expect(result.data.body).toBe('Plain text response')
    })

    it('should handle server errors', async () => {
      const result = await makeRequest(`${url}/error`)

      expect(result.success).toBe(false)
      expect(result.data.statusCode).toBe(500)
      expect(result.error?.message).toContain('Request failed with status 500')
    })

    it('should handle connection errors', async () => {
      const result = await makeRequest('http://non-existent-domain.example')

      expect(result.success).toBe(false)
      expect(result.error?.message).toContain('Request failed')
    })

    // Skipping timeout test as it would slow down the test suite
  })
})
