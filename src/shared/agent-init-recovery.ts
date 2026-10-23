import { CONFIG_EDIT_KEYS, type ConfigEditKey } from './config-ack';

/** Recovery is provider-produced metadata, never inferred from error wording. */
export const AgentInitRecoveryKind = {
  CLEAR_SAVED_MODEL: 'clear_saved_model',
  CLEAR_SAVED_PREF: 'clear_saved_pref',
} as const;

interface LegacyModelRecovery {
  kind: typeof AgentInitRecoveryKind.CLEAR_SAVED_MODEL;
  model: string;
}

export interface SavedPrefRecovery {
  kind: typeof AgentInitRecoveryKind.CLEAR_SAVED_PREF;
  key: ConfigEditKey;
  savedValue: string;
  label: string;
}
export type AgentInitRecovery = LegacyModelRecovery | SavedPrefRecovery;

const PREF_LABELS: Record<ConfigEditKey, string> = {
  [CONFIG_EDIT_KEYS.MODEL]: 'model', [CONFIG_EDIT_KEYS.EFFORT]: 'effort',
  [CONFIG_EDIT_KEYS.PERMISSION_MODE]: 'permission', [CONFIG_EDIT_KEYS.NATIVE_MODE]: 'mode',
  [CONFIG_EDIT_KEYS.NATIVE_PERMISSION]: 'permission', [CONFIG_EDIT_KEYS.NATIVE_APPROVAL]: 'approval',
};

export function savedPrefRecovery(key: ConfigEditKey, savedValue: string, label: string = PREF_LABELS[key]): SavedPrefRecovery {
  return { kind: AgentInitRecoveryKind.CLEAR_SAVED_PREF, key, savedValue, label };
}

/** Normalize legacy model metadata at the transaction boundary. */
export function recoverySelection(value: unknown): SavedPrefRecovery | undefined {
  const recovery = readInitRecovery(value);
  if (!recovery) return undefined;
  return recovery.kind === AgentInitRecoveryKind.CLEAR_SAVED_MODEL
    ? savedPrefRecovery(CONFIG_EDIT_KEYS.MODEL, recovery.model, 'model') : recovery;
}

export function readInitRecovery(value: unknown): AgentInitRecovery | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value !== null
    && 'kind' in value && value.kind === AgentInitRecoveryKind.CLEAR_SAVED_MODEL
    && 'model' in value && typeof value.model === 'string' && value.model.length > 0) {
    return { kind: value.kind, model: value.model };
  }
  if (typeof value === 'object' && value !== null
    && 'kind' in value && value.kind === AgentInitRecoveryKind.CLEAR_SAVED_PREF
    && 'key' in value && Object.values(CONFIG_EDIT_KEYS).includes(value.key as ConfigEditKey)
    && 'savedValue' in value && typeof value.savedValue === 'string' && value.savedValue.length > 0
    && 'label' in value && typeof value.label === 'string' && value.label.length > 0) {
    return savedPrefRecovery(value.key as ConfigEditKey, value.savedValue, value.label);
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
