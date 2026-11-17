export const SKILL_INVOCATION = {
  KIND: 'app-skill',
  VALIDATE: 'skill_invocation_validate',
  RESULT: 'skill_invocation_validate_result',
  TIMEOUT_MS: 10_000,
} as const;
export const SKILL_COMMAND_ERROR = {
  INVALID: 'invalid_command', STALE: 'stale_selection', CHANGED: 'target_changed',
  DISABLED: 'target_disabled', CONFLICT: 'command_conflict', UNAVAILABLE: 'native_unavailable',
  SOURCE: 'source_unverified', PROJECTION: 'projection_mismatch', TIMEOUT: 'validation_timeout',
} as const;
export type SkillCommandErrorCode = typeof SKILL_COMMAND_ERROR[keyof typeof SKILL_COMMAND_ERROR];
export interface SkillCommandSelection { registrationId: string; catalogRevision: string }
export interface SkillInvocation {
  kind: typeof SKILL_INVOCATION.KIND;
  bindingId: string;
  skillName: string;
  registrationId: string;
  alias: string;
  args: string;
  payloadDigest: string;
}
export type SkillValidationResult = { ok: true } | { ok: false; code: SkillCommandErrorCode; error: string };
export interface SkillValidationRequest {
  requestId: string;
  executionId: string;
  msgId: string;
  invocation: SkillInvocation;
}
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validSkillCommandSelection(v: unknown): v is SkillCommandSelection {
  return record(v) && Object.keys(v).every(k => ['registrationId', 'catalogRevision'].includes(k)) && uuid(v.registrationId) && digest(v.catalogRevision);
}
export function validSkillInvocation(v: unknown): v is SkillInvocation {
  return record(v) && Object.keys(v).every(k => ['kind', 'bindingId', 'skillName', 'registrationId', 'alias', 'args', 'payloadDigest'].includes(k))
    && v.kind === SKILL_INVOCATION.KIND && uuid(v.bindingId) && uuid(v.registrationId) && digest(v.payloadDigest)
    && typeof v.skillName === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.skillName)
    && typeof v.alias === 'string' && v.alias.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.alias)
    && typeof v.args === 'string' && !/[\r\n\u2028\u2029]/.test(v.args);
}
export function validSkillValidationRequest(v: unknown): v is SkillValidationRequest {
  return record(v) && typeof v.requestId === 'string' && !!v.requestId && typeof v.executionId === 'string' && !!v.executionId
    && typeof v.msgId === 'string' && !!v.msgId && validSkillInvocation(v.invocation);
}
export function validSkillValidationResult(v: unknown): v is SkillValidationResult {
  return record(v) && (v.ok === true || (v.ok === false && Object.values(SKILL_COMMAND_ERROR).includes(v.code as SkillCommandErrorCode) && typeof v.error === 'string'));
}
export class SkillCommandFailure extends Error {
  constructor(readonly code: SkillCommandErrorCode, message: string) { super(`[${code}] ${message}`); }
}

export const SKILL_COMMAND_AVAILABILITY = { READY: 'ready', PENDING: 'pending', DISABLED: 'disabled', CONFLICT: 'conflict', UNAVAILABLE: 'unavailable' } as const;
export type SkillCommandAvailability = typeof SKILL_COMMAND_AVAILABILITY[keyof typeof SKILL_COMMAND_AVAILABILITY];
export interface AppSkillCommandCapability { available: boolean; reason?: string }
export interface SkillCommandMenuEntry {
  name: string;
  description: string;
  skillName: string;
  selection: SkillCommandSelection;
  availability: SkillCommandAvailability;
  reason?: string;
}
export interface SkillCommandMenu { entries: SkillCommandMenuEntry[]; error?: string }
