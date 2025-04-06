import type { EmailOptions, EmailResult, Result } from 'unemail/types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEmailService } from 'unemail'
import smtpProvider from 'unemail/providers/smtp'

/**
 * This example demonstrates how to use unemail with MailCrab
 *
 * To run this example:
 * 1. Start MailCrab: docker run -p 1025:1025 -p 1080 marlonb/mailcrab
 * 2. Run this file: ts-node examples/mailcrab-example.ts
 * 3. Check the emails at http://localhost:1080
 */

// Calculate __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Create SMTP provider configured for MailCrab
const mailcrabInstance = smtpProvider({
  host: 'localhost',
  port: 1025, // Default MailCrab SMTP port
})

// Create an email service with the SMTP provider instance for MailCrab
const emailService = createEmailService({
  provider: mailcrabInstance,
  debug: true, // Enable debug logging
})

// Function to send a simple text email
async function sendSimpleEmail(): Promise<Result<EmailResult>> {
  console.log('Sending simple email...')

  const emailOptions: EmailOptions = {
    from: { email: 'sender@example.com', name: 'Sender Name' },
    to: { email: 'recipient@example.com', name: 'Recipient Name' },
    subject: 'Simple Text Email from unemail',
    text: 'This is a simple text email sent via unemail using MailCrab.',
  }

  return await emailService.sendEmail(emailOptions)
}

// Function to send an HTML email
async function sendHtmlEmail(): Promise<Result<EmailResult>> {
  console.log('Sending HTML email...')

  const emailOptions: EmailOptions = {
    from: { email: 'sender@example.com', name: 'unemail Library' },
    to: [
      { email: 'recipient1@example.com', name: 'Recipient 1' },
      { email: 'recipient2@example.com', name: 'Recipient 2' },
    ],
    cc: { email: 'cc@example.com', name: 'CC Recipient' },
    subject: 'HTML Email Example',
    text: 'This is the plain text version of the email for email clients that do not support HTML.',
    html: `
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .container { border: 1px solid #ddd; padding: 20px; border-radius: 5px; }
            .header { color: #0066cc; font-size: 24px; margin-bottom: 20px; }
            .content { line-height: 1.5; }
            .footer { margin-top: 30px; font-size: 12px; color: #666; border-top: 1px solid #eee; padding-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">Welcome to unemail!</div>
            <div class="content">
              <p>This is an <strong>HTML email</strong> sent using unemail library with MailCrab integration.</p>
              <p>Key features of unemail:</p>
              <ul>
                <li>Zero dependencies - no third-party libraries</li>
                <li>TypeScript first with full type definitions</li>
                <li>MailCrab integration for local development</li>
                <li>Extensible provider architecture</li>
                <li>Support for HTML emails and attachments</li>
              </ul>
            </div>
            <div class="footer">
              This email was sent from an example application. Please do not reply.
            </div>
          </div>
        </body>
      </html>
    `,
  }

  return await emailService.sendEmail(emailOptions)
}

// Function to send an email with attachments
async function sendEmailWithAttachments(): Promise<Result<EmailResult>> {
  console.log('Sending email with attachments...')

  // Create a text file as attachment
  const textContent = 'This is a sample text file created for the email attachment demo.'
  const textFilePath = path.join(__dirname, 'sample-attachment.txt')
  fs.writeFileSync(textFilePath, textContent)

  // Create a sample JSON file as attachment
  const jsonContent = JSON.stringify({
    library: 'unemail',
    version: '0.1.0',
    description: 'A TypeScript email library with direct API integration',
    features: ['Zero dependencies', 'TypeScript first', 'MailCrab integration'],
  }, null, 2)
  const jsonFilePath = path.join(__dirname, 'sample-data.json')
  fs.writeFileSync(jsonFilePath, jsonContent)

  const emailOptions: EmailOptions = {
    from: { email: 'sender@example.com', name: 'Attachment Demo' },
    to: { email: 'recipient@example.com', name: 'Attachment Recipient' },
    subject: 'Email with Attachments Example',
    text: 'This email contains attachments.',
    html: `
      <html>
        <body>
          <h2>Email with Attachments</h2>
          <p>This email demonstrates how to send attachments with unemail.</p>
          <p>Two attachments are included:</p>
          <ol>
            <li>A text file</li>
            <li>A JSON file</li>
          </ol>
        </body>
      </html>
    `,
    attachments: [
      {
        filename: 'sample-attachment.txt',
        content: fs.readFileSync(textFilePath),
        contentType: 'text/plain',
      },
      {
        filename: 'sample-data.json',
        content: fs.readFileSync(jsonFilePath),
        contentType: 'application/json',
      },
    ],
  }

  return await emailService.sendEmail(emailOptions)
}

// Main function to run the example
async function main() {
  try {
    // First check if MailCrab is available
    console.log('Checking if MailCrab is available...')
    const isAvailable = await emailService.isAvailable()

    if (!isAvailable) {
      console.error('MailCrab is not available. Please make sure it is running at localhost:1025')
      console.error('You can start it with: docker run -p 1025:1025 -p 1080:1080 marlonb/mailcrab')
      return
    }

    console.log('MailCrab is available! Proceeding with examples...\n')

    // Send a simple text email
    const simpleResult = await sendSimpleEmail()
    if (simpleResult.success) {
      console.log('✅ Simple text email sent successfully!')
      console.log('Message ID:', simpleResult.data?.messageId)
      console.log('Timestamp:', simpleResult.data?.timestamp)
    }
    else {
      console.error('❌ Failed to send simple text email:', simpleResult.error)
    }
    console.log(`\n${'-'.repeat(50)}\n`)

    // Send an HTML email
    const htmlResult = await sendHtmlEmail()
    if (htmlResult.success) {
      console.log('✅ HTML email sent successfully!')
      console.log('Message ID:', htmlResult.data?.messageId)
      console.log('Timestamp:', htmlResult.data?.timestamp)
    }
    else {
      console.error('❌ Failed to send HTML email:', htmlResult.error)
    }
    console.log(`\n${'-'.repeat(50)}\n`)

    // Send an email with attachments
    const attachmentResult = await sendEmailWithAttachments()
    if (attachmentResult.success) {
      console.log('✅ Email with attachments sent successfully!')
      console.log('Message ID:', attachmentResult.data?.messageId)
      console.log('Timestamp:', attachmentResult.data?.timestamp)
    }
    else {
      console.error('❌ Failed to send email with attachments:', attachmentResult.error)
    }

    console.log(`\n${'-'.repeat(50)}`)
    console.log('All examples completed! You can view the emails at http://localhost:1080')
    console.log(`${'-'.repeat(50)}\n`)

    // Clean up temporary files
    try {
      fs.unlinkSync(path.join(__dirname, 'sample-attachment.txt'))
      fs.unlinkSync(path.join(__dirname, 'sample-data.json'))
    }
    catch {
      // Ignore cleanup errors
    }
  }
  catch (error) {
    console.error('Unexpected error occurred:', error)
  }
}

// Run the main function
main().catch(console.error)
