// Codex subscription auth (device-code) — pure mapping half.
//
// Codex-SPECIFIC (lives in codex/, not the shared acp/ toolkit): subscription
// auth is driven OUT-OF-BAND from the ACP channel by calling codex's app-server
// `account/login/start {type:'chatgptDeviceCode'}`, which returns a structured
// verification URL + user code (NOT scraping the ratatui `codex login` TUI).
// This module maps that structured response onto Shelf's existing device-login
// wire event — the SAME event Copilot's GitHub device flow already emits, so the
// renderer's device-login UI is reused verbatim.
//
// The live app-server drive (spawn `codex app-server`, JSON-RPC, await
// `account/login/completed`) is binary-gated and lands with T0.3a/T4.0; this
// pure mapping is credential-free and unit-tested.

import type { OutgoingMessage } from '../types';

export const CODEX_PROVIDER = 'codex';

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
 * Map a codex device-code login response → the `auth_login_prompt` wire event.
 * `prefilledUri` mirrors `verificationUri` (codex hosts the code entry on the
 * verification page; no query-param convention is assumed).
 */
export function deviceCodeToAuthPrompt(login: CodexDeviceCodeLogin): AuthLoginPromptMessage {
  return {
    type: 'auth_login_prompt',
    provider: CODEX_PROVIDER,
    verificationUri: login.verificationUrl,
    userCode: login.userCode,
    prefilledUri: login.verificationUrl,
  };
}

/** Terminal login outcome → the `auth_login_done` wire event. */
export function authLoginDone(ok: boolean, opts: { cancelled?: boolean; error?: string } = {}): AuthLoginDoneMessage {
  return {
    type: 'auth_login_done',
    provider: CODEX_PROVIDER,
    ok,
    ...(opts.cancelled ? { cancelled: true } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  };
}
