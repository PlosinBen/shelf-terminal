export const APP_EXIT_DECISION = { CANCEL: 'cancel', RETRY: 'retry', FORCE: 'force' } as const;
export type AppExitDecision = typeof APP_EXIT_DECISION[keyof typeof APP_EXIT_DECISION];
export const APP_EXIT_PREPARE_TIMEOUT_MS = 10_000;
export const AGENT_EXIT_INTERRUPTED_LABEL = 'Interrupted when Shelf exited';

export interface AppExitRequest { requestId: string }
export type AppExitResult = AppExitRequest & ({ ok: true } | { ok: false; error: string });
