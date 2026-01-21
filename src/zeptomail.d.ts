declare module 'zeptomail' {
  export interface ClientParams {
    url: string
    token: string
  }

  export interface EmailAddress {
    address: string
    name?: string
  }

  export interface EmailAddressWrapper {
    email_address: EmailAddress
  }

  export interface Sendmail {
    from: EmailAddress
    to: EmailAddressWrapper[]
    cc?: EmailAddressWrapper[]
    bcc?: EmailAddressWrapper[]
    reply_to?: EmailAddress[]
    subject: string
    textbody?: string
    htmlbody?: string
    track_clicks?: boolean
    track_opens?: boolean
    client_reference?: string
    mime_headers?: Record<string, string>
    attachments?: Array<{
      name: string
      content?: string
      mime_type?: string
      file_cache_key?: string
    }>
  }

  export interface SendmailBatch {
    from: EmailAddress
    to: Array<EmailAddressWrapper & { merge_info?: Record<string, string> }>
    subject: string
    textbody?: string
    htmlbody?: string
  }

  export interface TemplateQueryParams {
    from: EmailAddress
    to: EmailAddressWrapper[]
    template_key: string
    merge_info?: Record<string, string>
  }

  export interface TemplateBatchParams {
    from: EmailAddress
    to: Array<EmailAddressWrapper & { merge_info?: Record<string, string> }>
    template_key: string
  }

  export class SendMailClient {
    constructor(options: ClientParams)
    sendMail(options: Sendmail): Promise<{ request_id?: string }>
    sendBatchMail(options: SendmailBatch): Promise<unknown>
    sendMailWithTemplate(options: TemplateQueryParams): Promise<unknown>
    mailBatchWithTemplate(options: TemplateBatchParams): Promise<unknown>
  }
}
