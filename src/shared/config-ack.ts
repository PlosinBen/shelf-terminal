/**
 * Canonical config-edit keys shared across the renderer (handleConfigEdit,
 * pickers) and the provider (applyConfigEdit). Note `permissionMode` — the
 * Claude slash uses `/permission` but the normalized key is `permissionMode`.
 */
export type ConfigEditKey = 'model' | 'effort' | 'permissionMode';

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
  }
}
