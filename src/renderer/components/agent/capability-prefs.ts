import type { AgentPrefs } from '@shared/types';
import type { PermissionControlCapabilities } from '@shared/permission-controls';

export function persistedPrefsFromCapabilities(
  capabilities: {
    permissionControl?: PermissionControlCapabilities;
    currentModel?: string;
    currentEffort?: string;
    currentPermissionMode?: string;
  },
  saved: AgentPrefs | undefined,
): Partial<AgentPrefs> {
  const partial: Partial<AgentPrefs> = {};
  if (capabilities.currentModel && capabilities.currentModel !== saved?.model) {
    partial.model = capabilities.currentModel;
  }
  if (capabilities.currentEffort && capabilities.currentEffort !== saved?.effort) {
    partial.effort = capabilities.currentEffort;
  }
  if (capabilities.permissionControl?.strategy !== 'native'
    && capabilities.currentPermissionMode
    && capabilities.currentPermissionMode !== saved?.permissionMode) {
    partial.permissionMode = capabilities.currentPermissionMode;
  }
  if (capabilities.permissionControl?.strategy === 'native') {
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
