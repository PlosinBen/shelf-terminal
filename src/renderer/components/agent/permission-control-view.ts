import type { ConfigEditKey } from '@shared/config-ack';
import type { PermissionControlCapabilities } from '@shared/permission-controls';

export interface PermissionControlViewOption {
  value: string;
  displayName: string;
  description?: string;
  severity?: 'normal' | 'info' | 'warning' | 'critical';
}

export interface PermissionControlView {
  key: Extract<ConfigEditKey, 'permissionMode' | 'nativeMode' | 'nativePermission'>;
  label: string;
  currentValue: string;
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
  if (control.mode?.currentValue && control.mode.options.length > 0) {
    views.push({
      key: 'nativeMode',
      label: control.mode.label,
      currentValue: control.mode.currentValue,
      options: control.mode.options,
    });
  }
  if (control.permission?.currentValue && control.permission.options.length > 0) {
    views.push({
      key: 'nativePermission',
      label: control.permission.label,
      currentValue: control.permission.currentValue,
      options: control.permission.options,
    });
  }
  return views;
}
