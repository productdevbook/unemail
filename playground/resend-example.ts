import type { EmailResult, Result } from 'unemail/types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { createEmailService } from 'unemail'
import resendProvider from 'unemail/providers/resend'

// Load environment variables from .env file first
dotenv.config()

/**
 * This example demonstrates how to use unemail with Resend
 *
 * To run this example:
 * 1. Set your Resend API key in the .env file or environment: RESEND_API_KEY
 * 2. Run this file: ts-node examples/resend-example.ts
 * 3. Check your email inbox for the test messages
 */

// Calculate __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Create Resend provider with configuration
const resendInstance = resendProvider({
  apiKey: process.env.RESEND_API_KEY || '',
  debug: true, // Enable debug logging
})

// Create an email service with the Resend provider instance
const emailService = createEmailService({
  provider: resendInstance,
  debug: true, // Enable debug logging
})

// Function to send a simple text email
async function sendSimpleEmail(): Promise<Result<EmailResult>> {
  return await emailService.sendEmail({
    from: {
      email: process.env.RESEND_FROM_EMAIL || 'bounced@resend.dev',
      name: 'Resend Example',
    },
    to: {
      email: process.env.RESEND_TO_EMAIL || 'delivered@resend.dev',
      name: 'Test Recipient',
    },
    subject: 'Testing Resend with unemail - Simple Text',
    text: 'This is a plain text message sent using unemail with Resend provider.',
  })
}

// Function to send an HTML email
async function sendHtmlEmail(): Promise<Result<EmailResult>> {
  return await emailService.sendEmail({
    from: {
      email: process.env.RESEND_FROM_EMAIL || 'bounced@resend.dev',
      name: 'Resend Example',
    },
    to: {
      email: process.env.RESEND_TO_EMAIL || 'delivered@resend.dev',
      name: 'Test Recipient',
    },
    subject: 'Testing Resend with unemail - HTML Content',
    text: 'This is a plain text alternative message for clients that do not support HTML.',
    html: `
      <h1>Testing Resend with unemail</h1>
      <p>This is an <strong>HTML message</strong> sent using <em>unemail</em> with Resend provider.</p>
      <p>If you're seeing this, the delivery was successful!</p>
    `,
  })
}

// Function to send an email with attachments
async function sendEmailWithAttachments(): Promise<Result<EmailResult>> {
  // Read a sample file to attach
  const attachmentPath = path.join(__dirname, '..', 'README.md')
  const fileContent = fs.readFileSync(attachmentPath)

  return await emailService.sendEmail({
    from: {
      email: process.env.RESEND_FROM_EMAIL || 'bounced@resend.dev',
      name: 'Resend Example',
    },
    to: {
      email: process.env.RESEND_TO_EMAIL || 'delivered@resend.dev',
      name: 'Test Recipient',
    },
    subject: 'Testing Resend with unemail - With Attachments',
    text: 'This email contains an attachment sent using unemail with Resend provider.',
    html: `
      <h1>Testing Resend with unemail</h1>
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

// Function to send an email with reply-to address
async function sendEmailWithReplyTo(): Promise<Result<EmailResult>> {
  return await emailService.sendEmail({
    from: {
      email: 'bounced@resend.dev',
      name: 'Resend Example',
    },
    to: {
      email: process.env.RESEND_TO_EMAIL || 'delivered@resend.dev',
      name: 'Test Recipient',
    },
    replyTo: {
      email: process.env.RESEND_REPLY_TO_EMAIL || 'delivered@resend.dev',
      name: 'Support Team',
    },
    subject: 'Testing Resend with unemail - Reply-To Feature',
    text: 'This email has a custom reply-to address. Try replying to this message!',
    html: `
      <h1>Testing Reply-To Feature</h1>
      <p>This email has a custom <strong>reply-to address</strong>.</p>
      <p>If you click reply in your email client, it should be addressed to our support team!</p>
    `,
  })
}

// Function to send a scheduled email
async function sendScheduledEmail(): Promise<Result<EmailResult>> {
  // Schedule email for 10 minutes from now
  const scheduledTime = new Date(Date.now() + 10 * 60 * 1000)

  return await emailService.sendEmail({
    from: {
      email: 'bounced@resend.dev',
      name: 'Resend Example',
    },
    to: {
      email: process.env.RESEND_TO_EMAIL || 'delivered@resend.dev',
      name: 'Test Recipient',
    },
    subject: 'Testing Resend with unemail - Scheduled Email',
    text: 'This email was scheduled to be delivered 10 minutes after the test was run.',
    html: `
      <h1>Scheduled Email Delivery</h1>
      <p>This email was scheduled to be delivered <strong>10 minutes</strong> after the test was run.</p>
      <p>Current time when test was executed: ${new Date().toISOString()}</p>
      <p>Scheduled delivery time: ${scheduledTime.toISOString()}</p>
    `,
    scheduledAt: scheduledTime,
  })
}

// Function to send an email with tags
async function sendEmailWithTags(): Promise<Result<EmailResult>> {
  return await emailService.sendEmail({
    from: {
      email: 'onboarding@resend.dev',
      name: 'Resend Example',
    },
    to: {
      email: process.env.RESEND_TO_EMAIL || 'recipient@example.com',
      name: 'Test Recipient',
    },
    subject: 'Testing Resend with unemail - Email with Tags',
    text: 'This email contains tags for analytics and filtering.',
    html: `
      <h1>Email with Tags</h1>
      <p>This email has been tagged for better <strong>analytics</strong> and <strong>filtering</strong>.</p>
      <p>You can use these tags in the Resend dashboard to track and categorize emails.</p>
    `,
    tags: [
      { name: 'category', value: 'test' },
      { name: 'version', value: 'v1_0_0' }, // Changed from "1.0.0" to "v1_0_0" to meet requirements
      { name: 'purpose', value: 'demo' },
    ],
  })
}

// Function to retrieve an email by ID
async function getEmailById(id: string): Promise<void> {
  if (!id) {
    console.error('❌ No email ID provided')
    return
  }

  console.log(`Retrieving email details for ID: ${id}...`)

  // Use the provider directly rather than trying to access it through emailService
  if (!resendInstance.getEmail) {
    console.error('❌ Provider does not support retrieving emails by ID')
    return
  }

  const result = await resendInstance.getEmail(id)

  if (result.success) {
    console.log('✅ Email details retrieved successfully:')
    console.log(JSON.stringify(result.data, null, 2))
  }
  else {
    console.error(`❌ Failed to retrieve email details:`, result.error?.message)
  }
}

// Main function to run the example
async function main() {
  try {
    // Check if the Resend provider is available
    const isAvailable = await emailService.isAvailable()

    if (!isAvailable) {
      console.error('❌ Resend API is not available. Check your API key and connectivity.')
      process.exit(1)
    }

    console.log('✅ Resend provider is available and properly configured.')

    // Send emails sequentially to avoid rate limiting
    console.log('\n=== Sending emails sequentially to avoid rate limiting ===\n')

    // Simple text email
    console.log('1. Sending simple text email...')
    const simpleResult = await sendSimpleEmail()
    if (simpleResult.success) {
      console.log(`✅ Simple text email sent successfully!`)
      console.log(`   Message ID: ${simpleResult.data?.messageId}`)
      console.log(`   Timestamp: ${simpleResult.data?.timestamp}`)
    }
    else {
      console.error(`❌ Failed to send simple text email:`, simpleResult.error?.message)
    }

    // Wait a moment before sending the next email to avoid rate limiting
    console.log('\nWaiting 2 seconds before sending next email...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // HTML email
    console.log('\n2. Sending HTML email...')
    const htmlResult = await sendHtmlEmail()
    if (htmlResult.success) {
      console.log(`✅ HTML email sent successfully!`)
      console.log(`   Message ID: ${htmlResult.data?.messageId}`)
      console.log(`   Timestamp: ${htmlResult.data?.timestamp}`)
    }
    else {
      console.error(`❌ Failed to send HTML email:`, htmlResult.error?.message)
    }

    // Wait a moment before sending the next email
    console.log('\nWaiting 2 seconds before sending next email...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Email with attachments
    console.log('\n3. Sending email with attachments...')
    const attachmentResult = await sendEmailWithAttachments()
    if (attachmentResult.success) {
      console.log(`✅ Email with attachments sent successfully!`)
      console.log(`   Message ID: ${attachmentResult.data?.messageId}`)
      console.log(`   Timestamp: ${attachmentResult.data?.timestamp}`)
    }
    else {
      console.error(`❌ Failed to send email with attachments:`, attachmentResult.error?.message)
    }

    // Wait a moment before sending the next email
    console.log('\nWaiting 2 seconds before sending next email...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Email with reply-to
    console.log('\n4. Sending email with reply-to address...')
    const replyToResult = await sendEmailWithReplyTo()
    if (replyToResult.success) {
      console.log(`✅ Email with reply-to sent successfully!`)
      console.log(`   Message ID: ${replyToResult.data?.messageId}`)
      console.log(`   Timestamp: ${replyToResult.data?.timestamp}`)
    }
    else {
      console.error(`❌ Failed to send email with reply-to:`, replyToResult.error?.message)
    }

    // Wait a moment before sending the next email
    console.log('\nWaiting 2 seconds before sending next email...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Email with tags
    console.log('\n5. Sending email with tags...')
    const tagResult = await sendEmailWithTags()
    if (tagResult.success) {
      console.log(`✅ Email with tags sent successfully!`)
      console.log(`   Message ID: ${tagResult.data?.messageId}`)
      console.log(`   Timestamp: ${tagResult.data?.timestamp}`)

      // Store the message ID for later retrieval
      const messageId = tagResult.data?.messageId

      // Wait a moment before retrieving the email
      console.log('\nWaiting 5 seconds before retrieving the email details...')
      await new Promise(resolve => setTimeout(resolve, 5000))

      // Check if messageId exists before retrieving the email
      if (messageId) {
        // Retrieve the email details
        await getEmailById(messageId)
      }
      else {
        console.error('❌ No message ID available to retrieve email details')
      }
    }
    else {
      console.error(`❌ Failed to send email with tags:`, tagResult.error?.message)
    }

    // Wait a moment before sending the next email
    console.log('\nWaiting 2 seconds before sending next email...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Scheduled email
    console.log('\n6. Scheduling email for 10 minutes from now...')
    const scheduledResult = await sendScheduledEmail()
    if (scheduledResult.success) {
      console.log(`✅ Email scheduled successfully!`)
      console.log(`   Message ID: ${scheduledResult.data?.messageId}`)
      console.log(`   Timestamp: ${scheduledResult.data?.timestamp}`)
      console.log(`   Check your inbox in about 10 minutes to see the scheduled email.`)
    }
    else {
      console.error(`❌ Failed to schedule email:`, scheduledResult.error?.message)
    }
  }
  catch (error) {
    console.error('❌ Unexpected error:', error)
  }
}

// Run the main function
main().catch(console.error)
