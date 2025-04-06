import dotenv from 'dotenv'

// Import directly from main package and provider modules
import { createEmailService } from 'unemail'
import awsSesProvider from 'unemail/providers/aws-ses'

// Load environment variables from .env file first
dotenv.config()

async function main() {
  try {
    // Extract credentials explicitly
    const region = process.env.AWS_REGION
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

    if (!region || !accessKeyId || !secretAccessKey) {
      console.error('Missing required AWS credentials in .env file')
      process.exit(1)
    }

    // Create AWS SES provider instance with configuration
    const sesProvider = awsSesProvider({
      region,
      accessKeyId,
      secretAccessKey,
      // Optional parameters
      sessionToken: process.env.AWS_SESSION_TOKEN,
      endpoint: process.env.AWS_SES_ENDPOINT,
      apiVersion: process.env.AWS_SES_API_VERSION || '2010-12-01',
    })

    // Create email service with the configured provider instance
    const emailService = createEmailService({
      provider: sesProvider,
      debug: true, // Enable debug output
    })

    // Check if the provider is available
    const isAvailable = await emailService.isAvailable()
    if (!isAvailable) {
      console.error('AWS SES is not available. Check your credentials and connectivity.')
      process.exit(1)
    }

    console.log('AWS SES provider is available and properly configured.')

    // Send a test email
    const result = await emailService.sendEmail({
      from: {
        email: process.env.FROM_EMAIL || 'sender@example.com',
        name: 'AWS SES Example',
      },
      to: {
        email: process.env.TO_EMAIL || 'recipient@example.com',
        name: 'Test Recipient',
      },
      subject: 'Testing AWS SES with unemail (Zero-Dependency)',
      text: 'This is a plain text message sent using unemail with zero-dependency AWS SES provider.',
      html: `
        <h1>Testing AWS SES (Zero-Dependency)</h1>
        <p>This is an HTML message sent using <strong>unemail</strong> with zero-dependency AWS SES provider.</p>
        <p>If you're seeing this, the delivery was successful!</p>
      `,
      // Optional headers
      headers: {
        'X-Custom-Header': 'custom-value',
        'X-Application': 'unemail-zero-dependency-example',
      },
    })

    if (result.success) {
      console.log('Email sent successfully!')
      console.log('Message ID:', result.data?.messageId)
      console.log('Timestamp:', result.data?.timestamp)
    }
    else {
      console.error('Failed to send email:', result.error?.message)
    }
  }
  catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

// Run the example
main()

/*
To run this example:

1. Create a .env file with your AWS credentials:
   ```
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=your-access-key
   AWS_SECRET_ACCESS_KEY=your-secret-key
   FROM_EMAIL=verified-sender@example.com
   TO_EMAIL=recipient@example.com
   ```

2. Make sure you have verified your sender email in the AWS SES console
   (required if your account is in the SES sandbox)

3. Run the example:
   ```
   npm install dotenv
   node --loader ts-node/esm examples/aws-ses-example.ts
   ```
*/
