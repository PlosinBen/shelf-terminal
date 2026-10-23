import { CONFIG_EDIT_KEYS, type ConfigEditKey } from '@shared/config-ack';
import type { PermissionControlCapabilities } from '@shared/permission-controls';

export interface PermissionControlViewOption {
  value: string;
  displayName: string;
  description?: string;
  severity?: 'normal' | 'info' | 'warning' | 'critical';
}

export interface PermissionControlView {
  key: Extract<ConfigEditKey, 'permissionMode' | 'nativeMode' | 'nativePermission' | 'nativeApproval'>;
  label: string;
  currentValue?: string;
  currentDisplayName?: string;
  options: PermissionControlViewOption[];
}

export function permissionControlViews(input: {
  permissionModes: PermissionControlViewOption[];
  currentPermissionMode?: string;
  permissionControl?: PermissionControlCapabilities;
}): PermissionControlView[] {
  const control = input.permissionControl;
  if (!control || control.strategy === 'shelf') {
    if (!input.currentPermissionMode || input.permissionModes.length === 0) return [];
    return [{
      key: 'permissionMode',
      label: 'Permission mode',
      currentValue: input.currentPermissionMode,
      options: input.permissionModes,
    }];
  }

  const views: PermissionControlView[] = [];
  for (const [key, descriptor] of [
    [CONFIG_EDIT_KEYS.NATIVE_MODE, control.mode],
    [CONFIG_EDIT_KEYS.NATIVE_PERMISSION, control.permission],
    [CONFIG_EDIT_KEYS.NATIVE_APPROVAL, control.approval],
  ] as const) {
    if (descriptor && (descriptor.currentValue || descriptor.currentDisplayName)) {
      views.push({ key, label: descriptor.label, currentValue: descriptor.currentValue,
        currentDisplayName: descriptor.currentDisplayName, options: descriptor.options });
    }
  }
  return views;
}
