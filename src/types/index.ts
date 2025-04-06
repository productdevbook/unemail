import type { Buffer } from 'node:buffer'

export type MaybePromise<T> = T | Promise<T>

export interface FeatureFlags {
  attachments?: boolean
  html?: boolean
  templates?: boolean
  tracking?: boolean
  customHeaders?: boolean
  batchSending?: boolean
  scheduling?: boolean
  replyTo?: boolean
  tagging?: boolean
}

export interface BaseConfig {
  debug?: boolean
  timeout?: number
  retries?: number
}

export interface EmailAddress {
  name?: string
  email: string
}

export interface Attachment {
  filename: string
  content: string | Buffer
  contentType?: string
  disposition?: string
  cid?: string
  path?: string
}

export interface EmailTag {
  name: string
  value: string
}

/**
 * Common email options that all providers support
 */
export interface EmailOptions {
  // Required fields
  from: EmailAddress
  to: EmailAddress | EmailAddress[]
  subject: string

  // Optional fields - commonly supported
  text?: string
  html?: string
  cc?: EmailAddress | EmailAddress[]
  bcc?: EmailAddress | EmailAddress[]
  headers?: Record<string, string>

  // File attachments - providers that don't support it will gracefully ignore
  attachments?: Attachment[]

  // Reply-to address - providers that don't support it will gracefully ignore
  replyTo?: EmailAddress
}

export interface EmailResult {
  messageId: string
  sent: boolean
  timestamp: Date
  provider?: string
  response?: any
}

export interface Result<T = any> {
  success: boolean
  data?: T
  error?: Error
}

export interface ErrorOptions {
  cause?: Error
  code?: string
}

// Provider-specific configuration types
export interface AwsSesConfig extends BaseConfig {
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  endpoint?: string
  maxAttempts?: number
  apiVersion?: string
}

export interface MailCrabConfig {
  host?: string
  port?: number
  secure?: boolean
  user?: string
  password?: string
}

export interface ResendConfig extends BaseConfig {
  apiKey: string
  endpoint?: string
  timeout?: number
  retries?: number
}

export interface SmtpConfig {
  host: string
  port: number
  secure?: boolean
  user?: string
  password?: string
}

export interface HttpEmailConfig {
  endpoint: string
  apiKey?: string
  method?: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
}

// Updated to use a generic options object instead of specific provider strings
export interface EmailServiceConfig {
  options: Record<string, any>
}
