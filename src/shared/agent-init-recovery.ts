/** Recovery is provider-produced metadata, never inferred from error wording. */
export const AgentInitRecoveryKind = {
  CLEAR_SAVED_MODEL: 'clear_saved_model',
} as const;

export interface AgentInitRecovery {
  kind: typeof AgentInitRecoveryKind.CLEAR_SAVED_MODEL;
  model: string;
}

export function readInitRecovery(value: unknown): AgentInitRecovery | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value !== null
    && 'kind' in value && value.kind === AgentInitRecoveryKind.CLEAR_SAVED_MODEL
    && 'model' in value && typeof value.model === 'string' && value.model.length > 0) {
    return { kind: value.kind, model: value.model };
  }
  console.warn('[agent-init] unrecognized recovery metadata', value);
  return undefined;
}

export class AgentInitializationError extends Error {
  constructor(message: string, readonly recovery?: AgentInitRecovery) {
    super(message);
    this.name = 'AgentInitializationError';
  }
}

export function recoveryFromError(error: unknown): AgentInitRecovery | undefined {
  return typeof error === 'object' && error !== null && 'recovery' in error
    ? readInitRecovery(error.recovery) : undefined;
}
