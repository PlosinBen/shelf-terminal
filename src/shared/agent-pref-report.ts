import type { AgentPrefs } from './types';
import type { AgentPreferenceReport } from './project-mutations';
import { PERMISSION_CONTROL_STRATEGIES } from './permission-controls';

export function persistedPrefsFromCapabilities(
  capabilities: AgentPreferenceReport,
  saved: AgentPrefs | undefined,
): Partial<AgentPrefs> {
  if (capabilities.confirmedPrefs !== undefined) return capabilities.confirmedPrefs;
  const partial: Partial<AgentPrefs> = {};
  if (capabilities.currentModel && capabilities.currentModel !== saved?.model) {
    partial.model = capabilities.currentModel;
  }
  if (capabilities.currentEffort && capabilities.currentEffort !== saved?.effort) {
    partial.effort = capabilities.currentEffort;
  }
  if (capabilities.permissionControl?.strategy !== PERMISSION_CONTROL_STRATEGIES.NATIVE
    && capabilities.currentPermissionMode
    && capabilities.currentPermissionMode !== saved?.permissionMode) {
    partial.permissionMode = capabilities.currentPermissionMode;
  }
  if (capabilities.permissionControl?.strategy === PERMISSION_CONTROL_STRATEGIES.NATIVE) {
    const nativeMode = capabilities.permissionControl.mode?.currentValue;
    if (nativeMode && nativeMode !== saved?.nativeMode) {
      partial.nativeMode = nativeMode;
    }
    const nativePermission = capabilities.permissionControl.permission?.currentValue;
    if (nativePermission && nativePermission !== saved?.nativePermission) {
      partial.nativePermission = nativePermission;
    }
  }
  return partial;
}
