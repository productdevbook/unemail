/**
 * AWS SQS queue adapter. Structural — pass any SQS-compatible client
 * with `SendMessage` / `ReceiveMessage` / `DeleteMessage` commands.
 *
 * @module
 */

import type { EmailMessage } from "../types.ts"
import type { EmailQueue, QueueEnqueueOptions, QueueItem } from "./index.ts"

export interface SqsLike {
  sendMessage: (input: {
    QueueUrl: string
    MessageBody: string
    DelaySeconds?: number
    MessageDeduplicationId?: string
  }) => Promise<{ MessageId?: string }>
  receiveMessage: (input: {
    QueueUrl: string
    MaxNumberOfMessages?: number
    WaitTimeSeconds?: number
  }) => Promise<{ Messages?: Array<{ MessageId?: string; ReceiptHandle?: string; Body?: string }> }>
  deleteMessage: (input: { QueueUrl: string; ReceiptHandle: string }) => Promise<void>
}

export interface SqsQueueOptions {
  sqs: SqsLike
  queueUrl: string
}

export function sqsQueue(options: SqsQueueOptions): EmailQueue {
  const receipts = new Map<string, string>()
  return {
    name: "sqs",
    async enqueue(msg: EmailMessage, opts: QueueEnqueueOptions = {}) {
      const scheduled = msg.scheduledAt ? new Date(msg.scheduledAt).getTime() : 0
      const visible = Math.max(Date.now() + (opts.delayMs ?? 0), scheduled)
      const delaySeconds = Math.min(900, Math.max(0, Math.floor((visible - Date.now()) / 1000)))
      const res = await options.sqs.sendMessage({
        QueueUrl: options.queueUrl,
        MessageBody: JSON.stringify(msg),
        DelaySeconds: delaySeconds,
        MessageDeduplicationId: opts.id,
      })
      return {
        id: res.MessageId ?? opts.id ?? `sqs_${Date.now().toString(36)}`,
        msg,
        attempts: 0,
        nextAttemptAt: visible,
        createdAt: Date.now(),
      }
    },
    async pull(limit = 10) {
      const out = await options.sqs.receiveMessage({
        QueueUrl: options.queueUrl,
        MaxNumberOfMessages: Math.min(10, limit),
        WaitTimeSeconds: 0,
      })
      const items: QueueItem[] = []
      for (const m of out.Messages ?? []) {
        if (!m.MessageId || !m.ReceiptHandle || !m.Body) continue
        receipts.set(m.MessageId, m.ReceiptHandle)
        items.push({
          id: m.MessageId,
          msg: JSON.parse(m.Body) as EmailMessage,
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: Date.now(),
        })
      }
      return items
    },
    async ack(id: string) {
      const handle = receipts.get(id)
      if (!handle) return
      await options.sqs.deleteMessage({ QueueUrl: options.queueUrl, ReceiptHandle: handle })
      receipts.delete(id)
    },
    async fail() {
      // SQS re-delivers messages whose ReceiptHandle expires — we
      // simply drop the handle so the message returns to the queue
      // after its visibility timeout.
    },
    async size() {
      return -1 // SQS doesn't expose size cheaply; use CloudWatch.
    },
  }
}

export default sqsQueue
