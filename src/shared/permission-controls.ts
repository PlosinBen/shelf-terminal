export const PERMISSION_CONTROL_STRATEGIES = {
  SHELF: 'shelf',
  NATIVE: 'native',
} as const;

export type PermissionControlStrategy =
  typeof PERMISSION_CONTROL_STRATEGIES[keyof typeof PERMISSION_CONTROL_STRATEGIES];

export interface NativePermissionControlOption {
  value: string;
  displayName: string;
  description?: string;
}

export interface NativePermissionControlDescriptor {
  label: string;
  description?: string;
  currentValue?: string;
  options: NativePermissionControlOption[];
}

export type PermissionControlCapabilities =
  | { strategy: typeof PERMISSION_CONTROL_STRATEGIES.SHELF }
  | {
      strategy: typeof PERMISSION_CONTROL_STRATEGIES.NATIVE;
      mode?: NativePermissionControlDescriptor;
      permission?: NativePermissionControlDescriptor;
    };

export const SHELF_PERMISSION_CONTROL = {
  strategy: PERMISSION_CONTROL_STRATEGIES.SHELF,
} as const satisfies PermissionControlCapabilities;
