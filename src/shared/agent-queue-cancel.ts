export const QUEUE_CANCEL = {
  REQUEST: 'cancel_queued',
  RESPONSE: 'cancel_queued_result',
  STATUS: { CANCELLED: 'cancelled', RUNNING: 'running', NOT_FOUND: 'not_found' },
  TIMEOUT_MS: 10_000,
} as const;
export type QueueCancelStatus = typeof QUEUE_CANCEL.STATUS[keyof typeof QUEUE_CANCEL.STATUS];
export interface QueueCancelResult { status: QueueCancelStatus }
