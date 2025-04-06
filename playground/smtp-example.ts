import type { EmailResult, Result } from 'unemail/types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { createEmailService } from 'unemail'
import smtpProvider from 'unemail/providers/smtp'

// Load environment variables from .env file first
dotenv.config()

/**
 * This example demonstrates how to use unemail with SMTP
 *
 * To run this example:
 * 1. Set up your SMTP configuration in .env file or environment variables:
 *    SMTP_HOST=smtp.example.com
 *    SMTP_PORT=587 (or your SMTP port)
 *    SMTP_USER=your-username
 *    SMTP_PASSWORD=your-password
 *    SMTP_SECURE=true/false (use TLS)
 *    FROM_EMAIL=sender@example.com
 *    TO_EMAIL=recipient@example.com
 *
 * 2. Run this file: ts-node playground/smtp-example.ts
 * 3. Check your email inbox for the test messages
 */

// Calculate __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Create SMTP provider with configuration
const smtpInstance = smtpProvider({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: process.env.SMTP_PORT ? Number.parseInt(process.env.SMTP_PORT, 10) : 587,
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER,
  password: process.env.SMTP_PASSWORD,
})

// Create an email service with the SMTP provider instance
const emailService = createEmailService({
  provider: smtpInstance,
  debug: true, // Enable debug logging
})

// Function to send a simple text email
async function sendSimpleEmail(): Promise<Result<EmailResult>> {
  console.log('Sending simple text email...')

  return await emailService.sendEmail({
    from: {
      email: process.env.FROM_EMAIL || 'sender@example.com',
      name: 'SMTP Example',
    },
    to: {
      email: process.env.TO_EMAIL || 'recipient@example.com',
      name: 'Test Recipient',
    },
    subject: 'Testing SMTP with unemail - Simple Text',
    text: 'This is a plain text message sent using unemail with SMTP provider.',
  })
}

// Function to send an HTML email
async function sendHtmlEmail(): Promise<Result<EmailResult>> {
  console.log('Sending HTML email...')

  return await emailService.sendEmail({
    from: {
      email: process.env.FROM_EMAIL || 'sender@example.com',
      name: 'SMTP Example',
    },
    to: {
      email: process.env.TO_EMAIL || 'recipient@example.com',
      name: 'Test Recipient',
    },
    subject: 'Testing SMTP with unemail - HTML Content',
    text: 'This is a plain text alternative message for clients that do not support HTML.',
    html: `
      <h1>Testing SMTP with unemail</h1>
      <p>This is an <strong>HTML message</strong> sent using <em>unemail</em> with SMTP provider.</p>
      <p>If you're seeing this, the delivery was successful!</p>
    `,
  })
}

// Function to send an email with attachments
async function sendEmailWithAttachments(): Promise<Result<EmailResult>> {
  console.log('Sending email with attachments...')

  // Read a sample file to attach
  const attachmentPath = path.join(__dirname, '..', 'README.md')
  const fileContent = fs.readFileSync(attachmentPath)

  return await emailService.sendEmail({
    from: {
      email: process.env.FROM_EMAIL || 'sender@example.com',
      name: 'SMTP Example',
    },
    to: {
      email: process.env.TO_EMAIL || 'recipient@example.com',
      name: 'Test Recipient',
    },
    subject: 'Testing SMTP with unemail - With Attachments',
    text: 'This email contains an attachment sent using unemail with SMTP provider.',
    html: `
      <h1>Testing SMTP with unemail</h1>
      <p>This email contains an <strong>attachment</strong>.</p>
      <p>Check the README.md attachment for details about unemail.</p>
    `,
    attachments: [
      {
        filename: 'README.md',
        content: fileContent,
        contentType: 'text/markdown',
      },
    ],
  })
}

// Function to send an email with DSN and high priority
async function sendDsnPriorityEmail(): Promise<Result<EmailResult>> {
  console.log('Sending email with DSN and high priority...')

  return await emailService.sendEmail({
    from: {
      email: process.env.FROM_EMAIL || 'sender@example.com',
      name: 'SMTP Example',
    },
    to: {
      email: process.env.TO_EMAIL || 'recipient@example.com',
      name: 'Test Recipient',
    },
    subject: 'High Priority Email with Delivery Notification',
    text: 'This is a high priority email with delivery status notification requested.',
    html: `
      <h1>High Priority Email</h1>
      <p>This email was sent with <strong>high priority</strong> and requests delivery status notification.</p>
    `,
    // SMTP-specific options
    priority: 'high',
    dsn: {
      success: true,
      failure: true,
      delay: true,
    },
  })
}

// Main function to run the example
async function main() {
  try {
    // First check if the SMTP provider is available
    console.log('Checking if SMTP provider is available...')
    const isAvailable = await emailService.isAvailable()

    if (!isAvailable) {
      console.error('SMTP server is not available. Check your configuration and connectivity.')
      process.exit(1)
    }

    console.log('SMTP server is available and properly configured.')

    // Send the emails
    console.log('\n--- Sending Test Emails ---\n')

    // Send a simple text email
    const simpleResult = await sendSimpleEmail()
    console.log('Simple email result:', simpleResult.success ? 'SUCCESS' : 'FAILED', '\n')

    // Send an HTML email
    const htmlResult = await sendHtmlEmail()
    console.log('HTML email result:', htmlResult.success ? 'SUCCESS' : 'FAILED', '\n')

    // Send an email with attachments
    const attachmentResult = await sendEmailWithAttachments()
    console.log('Email with attachments result:', attachmentResult.success ? 'SUCCESS' : 'FAILED', '\n')

    // Send an email with DSN and high priority
    const dsnResult = await sendDsnPriorityEmail()
    console.log('Email with DSN and priority result:', dsnResult.success ? 'SUCCESS' : 'FAILED', '\n')

    console.log('All test emails sent!')
  }
  catch (error) {
    console.error('An error occurred:', error)
    process.exit(1)
  }
}

// Run the main function
main().catch(console.error)
