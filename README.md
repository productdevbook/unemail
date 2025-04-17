# unemail

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

A modern, TypeScript-first email sending library with support for multiple providers and ESM-only architecture.

## Supported Email Services

- **SMTP** - Any standard SMTP server including Gmail, Outlook, Office 365, etc.
- **AWS SES** - Amazon Simple Email Service
- **Resend** - Modern email API for developers
- **HTTP API** - Custom HTTP API endpoints for email delivery
- **MailCrab** - Local development email testing (via SMTP provider)

> 📢 **Want to add a provider?** We welcome pull requests for new providers! See the [Creating Custom Email Providers](#creating-custom-email-providers) section for guidance.

## Features

- 📦 **Multiple Providers** - Support for various email services including AWS SES, MailCrab, HTTP APIs, and more
- 🔌 **Provider Pattern** - Easily extend with custom providers
- 🔄 **Type-safe** - Full TypeScript support with generics and strict typing
- 📤 **ESM Only** - Modern ES modules architecture
- 🧪 **Well-tested** - Comprehensive test suite for all components
- 📄 **Zero External Dependencies** - Core functionality has no runtime dependencies
- 🔒 **Error Handling** - Consistent error handling across all providers

## Installation

```bash
# Using pnpm
pnpm add unemail

# Using npm
npm install unemail

# Using yarn
yarn add unemail
```

## Quick Start

```typescript
import { createEmailService } from 'unemail'
import httpProvider from 'unemail/providers/http'

// Create a service with your preferred provider
const emailService = createEmailService({
  provider: httpProvider({
    endpoint: 'https://api.example.com/email',
    apiKey: 'your-api-key'
  })
})

// Send an email
const result = await emailService.sendEmail({
  from: { email: 'sender@example.com', name: 'Sender Name' },
  to: { email: 'recipient@example.com', name: 'Recipient Name' },
  subject: 'Hello from unemail',
  text: 'This is a test email sent using unemail library',
  html: '<p>This is a test email sent using <strong>unemail</strong> library</p>'
})

if (result.success) {
  console.log('Email sent successfully!', result.data.messageId)
}
else {
  console.error('Failed to send email:', result.error)
}
```

## Available Providers

### AWS SES Provider

```typescript
import { createEmailService } from 'unemail'
import awsSesProvider from 'unemail/providers/aws-ses'

const emailService = createEmailService({
  provider: awsSesProvider({
    accessKeyId: 'AWS_ACCESS_KEY',
    secretAccessKey: 'AWS_SECRET_KEY',
    region: 'us-east-1'
  })
})
```

### HTTP Provider

```typescript
import { createEmailService } from 'unemail'
import httpProvider from 'unemail/providers/http'

const emailService = createEmailService({
  provider: httpProvider({
    endpoint: 'https://api.yourservice.com/send',
    apiKey: 'your-api-key',
    method: 'POST', // optional, defaults to POST
    headers: { // optional, additional headers
      'X-Custom-Header': 'custom-value'
    }
  })
})
```

### MailCrab Provider (for development)

```typescript
import { createEmailService } from 'unemail'
import smtpProvider from 'unemail/providers/smtp'

const emailService = createEmailService({
  provider: smtpProvider({
    host: 'localhost',
    port: 1025, // default MailCrab port
    secure: false // typically false for development
  })
})
```

### SMTP Provider

```typescript
import { createEmailService } from 'unemail'
import smtpProvider from 'unemail/providers/smtp'

// Basic configuration
const emailService = createEmailService({
  provider: smtpProvider({
    host: 'smtp.example.com',
    port: 587,
    secure: false, // use TLS
    user: 'username',
    password: 'password'
  })
})

// Advanced configuration with enhanced security and features
const advancedEmailService = createEmailService({
  provider: smtpProvider({
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'username',
    password: 'password',

    // TLS options
    rejectUnauthorized: true, // Verify SSL certificates (set to false to ignore certificate errors)

    // Connection pooling for sending multiple emails efficiently
    pool: true,
    maxConnections: 5,

    // Enhanced authentication
    authMethod: 'CRAM-MD5', // 'LOGIN', 'PLAIN', 'CRAM-MD5', or 'OAUTH2'

    // OAuth2 authentication (if using OAUTH2 authMethod)
    oauth2: {
      user: 'user@example.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      expires: 1714939200000
    },

    // DKIM signing to improve deliverability
    dkim: {
      domainName: 'example.com',
      keySelector: 'mail',
      privateKey: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
    }
  })
})

// Basic email sending
await emailService.sendEmail({
  from: { email: 'sender@example.com', name: 'Sender' },
  to: { email: 'recipient@example.com' },
  subject: 'Test email',
  text: 'Plain text content',
  html: '<p>HTML content</p>'
})

// Advanced email sending with SMTP-specific options
await advancedEmailService.sendEmail({
  from: { email: 'sender@example.com', name: 'Sender' },
  to: { email: 'recipient@example.com' },
  subject: 'Test email',
  text: 'Plain text content',
  html: '<p>HTML content</p>',

  // Basic SMTP-specific options
  priority: 'high', // 'high', 'normal', or 'low'
  dsn: {
    success: true, // Request successful delivery notification
    failure: true, // Request failure notification
    delay: true // Request delay notification
  },

  // Threading and references
  inReplyTo: '<previous-message-id@example.com>',
  references: ['<ref1@example.com>', '<ref2@example.com>'],

  // Email management
  listUnsubscribe: 'mailto:unsubscribe@example.com',

  // Gmail-specific features
  googleMailHeaders: {
    promotionalContent: true, // Mark as promotional content
    feedbackId: 'campaign:12345:user:123', // For engagement tracking
    category: 'promotions' // 'primary', 'social', 'promotions', 'updates', or 'forums'
  },

  // Control DKIM signing per email
  useDkim: true
})
```

### Resend Provider

```typescript
import { createEmailService } from 'unemail'
import resendProvider from 'unemail/providers/resend'

const emailService = createEmailService({
  provider: resendProvider({
    apiKey: 'your-resend-api-key'
  })
})
```

## Email Options

Send emails with a variety of options:

```typescript
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
const result = await emailService.sendEmail({
  // Required fields
  from: { email: 'sender@example.com', name: 'Sender Name' },
  to: [
    { email: 'recipient1@example.com', name: 'Recipient One' },
    { email: 'recipient2@example.com', name: 'Recipient Two' }
  ],
  subject: 'Test Email with Attachments',

  // Content - at least one of text or html is required
  text: 'Plain text version of the email',
  html: '<p>HTML version of the email</p>',

  // Optional fields
  cc: { email: 'cc@example.com', name: 'CC Recipient' },
  bcc: { email: 'bcc@example.com', name: 'BCC Recipient' },

  // Custom headers
  headers: {
    'X-Custom-Header': 'custom-value'
  },

  // Attachments
  attachments: [
    {
      filename: 'document.pdf',
      content: Buffer.from('...'), // Can be Buffer or Base64 string
      contentType: 'application/pdf'
    },
    {
      filename: 'image.png',
      content: fs.readFileSync('path/to/image.png'),
      contentType: 'image/png'
    }
  ],

  // Reply-to address
  replyTo: { email: 'reply@example.com', name: 'Reply Handler' }
})
```

## Creating Custom Email Providers

You can easily create custom providers for any email service:

```typescript
import type { EmailOptions, EmailResult, Result } from 'unemail'
import { createEmailService, defineProvider } from 'unemail'

// Define your provider
const myCustomProvider = defineProvider((options = {}) => {
  // Provider initialization
  const apiKey = options.apiKey
  const apiUrl = options.apiUrl || 'https://api.default-service.com'

  // Method implementations
  return {
    name: 'my-custom-provider',

    features: {
      attachments: true,
      html: true,
      templates: false,
      tracking: false
    },

    options,

    async initialize() {
      // Initialize your provider if needed
      // e.g. validate credentials, set up connections, etc.
    },

    async isAvailable() {
      // Check if the provider is available
      // e.g. test connection, validate credentials, etc.
      return true
    },

    async sendEmail(options: EmailOptions): Promise<Result<EmailResult>> {
      try {
        // Implementation of email sending logic

        // On success
        return {
          success: true,
          data: {
            messageId: 'generated-or-returned-message-id',
            sent: true,
            timestamp: new Date(),
            provider: 'my-custom-provider'
          }
        }
      }
      catch (error) {
        // On error
        return {
          success: false,
          error: error as Error
        }
      }
    }
  }
})

const emailService = createEmailService({
  provider: myCustomProvider({
    apiKey: 'your-api-key',
    apiUrl: 'https://api.your-service.com'
  })
})
```

## Error Handling

All provider methods return a standardized `Result` type:

```typescript
interface Result<T = any> {
  success: boolean
  data?: T
  error?: Error
}
```

This allows for consistent error handling:

```typescript
const result = await emailService.sendEmail({
  // email options...
})

if (result.success) {
  // Handle success
  console.log(`Email sent with ID: ${result.data.messageId}`)
}
else {
  // Handle error
  console.error(`Failed to send email: ${result.error.message}`)
}
```

## Development Setup

### Prerequisites

- Node.js 20.11.1 or higher
- pnpm

### Local Development

```bash
# Clone the repository
git clone https://github.com/your-username/unemail.git
cd unemail

# Install dependencies
pnpm install

# Build the package
pnpm build

# Run tests
pnpm test
```

### Testing with MailCrab

For local development, you can use MailCrab, a local SMTP server:

```bash
# Run the MailCrab setup script
pnpm mailcrab

# Test with the example script
pnpm example
```

#### unemail-mailcrab CLI

The package includes a CLI tool called `unemail-mailcrab` that helps you set up and manage a MailCrab container for local email testing:

```bash
# Install globally to use the CLI from anywhere
npm install -g unemail

# Run the CLI
unemail-mailcrab
```

The CLI tool:

- Checks if Docker is installed
- Verifies if ports 1025 (SMTP) and 1080 (Web UI) are available
- Pulls the MailCrab Docker image if not already available
- Manages existing MailCrab containers (start/stop/create new)
- Sets up a Docker container running MailCrab
- Provides detailed instructions for using MailCrab with unemail

After running the CLI, you can:
- Send emails to localhost:1025 using the MailCrab provider
- View all sent emails in the MailCrab web UI at http://localhost:1080
- Stop/start the container with `docker stop unemail-mailcrab` and `docker start unemail-mailcrab`

## Credits

This project's architecture and provider pattern was inspired by [unjs/unstorage](https://github.com/unjs/unstorage), which uses a similar approach for storage drivers.

## License

[MIT](./LICENSE) License © [productdevbook](https://github.com/productdevbook)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/unemail?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/unemail
[npm-downloads-src]: https://img.shields.io/npm/dm/unemail?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/unemail
[bundle-src]: https://deno.bundlejs.com/badge?q=unemail@0.0.4
[bundle-href]: https://deno.bundlejs.com/badge?q=unemail@0.0.4
[license-src]: https://img.shields.io/github/license/productdevbook/unemail.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/productdevbook/unemail/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/unemail
