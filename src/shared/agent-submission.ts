/** Serializable across IPC: submission errors are not execution outcomes. */
export const SUBMISSION_ERROR = {
  INVALID: 'invalid_input',
  TARGET_MISSING: 'target_missing',
  FORBIDDEN: 'forbidden',
  DUPLICATE: 'duplicate_submission',
  NOT_SENT: 'not_sent',
  UNCONFIRMED: 'unconfirmed',
  TIMEOUT: 'confirmation_timeout',
} as const;
export type SubmissionErrorCode = typeof SUBMISSION_ERROR[keyof typeof SUBMISSION_ERROR];
export interface SubmissionError { code: SubmissionErrorCode; message: string }
export type SubmissionResult = { ok: true } | { ok: false; error: SubmissionError };
export const QUEUE_PROJECTION = { OPTIMISTIC: 'optimistic', MIRRORED: 'mirrored' } as const;
export type QueueProjection = typeof QUEUE_PROJECTION[keyof typeof QUEUE_PROJECTION];
export function submissionFailed(code: SubmissionErrorCode, message: string): SubmissionResult {
  return { ok: false, error: { code, message } };
}
export function isSubmissionUncertain(error: SubmissionError): boolean {
  return error.code === SUBMISSION_ERROR.UNCONFIRMED || error.code === SUBMISSION_ERROR.TIMEOUT;
}
