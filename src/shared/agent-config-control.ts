import { CONFIG_EDIT_KEYS, type ConfigEditKey } from './config-ack';

export const CONFIG_CONTROL = {
  REQUEST: 'configure_session', RESPONSE: 'configure_session_result',
  EVENT: 'agent:configure',
  STATE: { DEFERRED: 'deferred', APPLYING: 'applying', CONFIRMED: 'confirmed', REJECTED: 'rejected', UNCERTAIN: 'uncertain' },
  ORIGIN: { STATUS_BAR: 'status-bar', SLASH: 'slash' },
  APPLY_TIMEOUT_MS: 30_000,
} as const;
export interface ConfigControlRequest { requestId: string; key: ConfigEditKey; value: string }
/** Only use before any upstream mutation has been attempted. */
export class ConfigControlRejectedError extends Error {}
export type ConfigControlState = typeof CONFIG_CONTROL.STATE[keyof typeof CONFIG_CONTROL.STATE];
export interface ConfigControlUpdate extends ConfigControlRequest { state: ConfigControlState; error?: string }
export function validConfigControl(value: unknown): value is ConfigControlRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as ConfigControlRequest;
  return typeof v.requestId === 'string' && v.requestId.length > 0 && v.requestId.length <= 160
    && Object.values(CONFIG_EDIT_KEYS).includes(v.key) && typeof v.value === 'string' && v.value.length > 0 && v.value.length <= 4096;
}
export function isConfigControlPending(state: ConfigControlState): boolean {
  return state === CONFIG_CONTROL.STATE.DEFERRED || state === CONFIG_CONTROL.STATE.APPLYING;
}
