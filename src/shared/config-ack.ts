/**
 * Canonical config-edit keys shared across the renderer (DecisionPanel
 * picker, /model slash) and the provider (applyConfigEdit). Note
 * `permissionMode` — the
 * Claude slash uses `/permission` but the normalized key is `permissionMode`.
 */
export const CONFIG_EDIT_KEYS = {
  MODEL: 'model',
  EFFORT: 'effort',
  PERMISSION_MODE: 'permissionMode',
  NATIVE_MODE: 'nativeMode',
  NATIVE_PERMISSION: 'nativePermission',
} as const;

export type ConfigEditKey = typeof CONFIG_EDIT_KEYS[keyof typeof CONFIG_EDIT_KEYS];

/**
 * Single source of truth for the config-change acknowledgement text rendered
 * as a `system` divider. Used by BOTH the provider (typed /model slash) and —
 * indirectly via the config-edit turn — the renderer's picker / status-bar
 * paths, so the wording can't drift between entry points.
 */
export function formatConfigAck(key: ConfigEditKey, value: string): string {
  switch (key) {
    case 'model':
      return `Model set to ${value} (applies on next query)`;
    case 'effort':
      return `Reasoning effort set to ${value} (applies on next query)`;
    case 'permissionMode':
      return `Permission mode set to ${value} (applies on next query)`;
    case 'nativeMode':
      return `Mode set to ${value}`;
    case 'nativePermission':
      return `Permission set to ${value}`;
  }
}
