import type { OutgoingMessage } from '../types';

export const CODEX_AUTH_DISPLAY_NAME = 'Codex';

/** Structured device-code login response from codex's app-server. */
export interface CodexDeviceCodeLogin {
  /** URL the user opens to authorize (codex's `verificationUrl`). */
  verificationUrl: string;
  /** One-time code the user enters after signing in (codex's `userCode`). */
  userCode: string;
}

export type AuthLoginPromptMessage = Extract<OutgoingMessage, { type: 'auth_login_prompt' }>;
export type AuthLoginDoneMessage = Extract<OutgoingMessage, { type: 'auth_login_done' }>;

/**
 * Map a codex device-code login response → Shelf's `auth_login_prompt` wire
 * event. `provider` is provider-owned display content; routing is already
 * session/tab scoped and must never derive identity from this value.
 */
export function deviceCodeToAuthPrompt(
  login: CodexDeviceCodeLogin,
  provider: string = CODEX_AUTH_DISPLAY_NAME,
): AuthLoginPromptMessage {
  return {
    type: 'auth_login_prompt',
    provider,
    verificationUri: login.verificationUrl,
    userCode: login.userCode,
    prefilledUri: login.verificationUrl,
  };
}

/** Terminal login outcome → the `auth_login_done` wire event. */
export function authLoginDone(
  ok: boolean,
  opts: { provider?: string; cancelled?: boolean; error?: string } = {},
): AuthLoginDoneMessage {
  return {
    type: 'auth_login_done',
    provider: opts.provider ?? CODEX_AUTH_DISPLAY_NAME,
    ok,
    ...(opts.cancelled ? { cancelled: true } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  };
}
