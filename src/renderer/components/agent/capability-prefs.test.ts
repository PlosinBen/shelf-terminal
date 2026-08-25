import { describe, expect, it } from 'vitest';
import { persistedPrefsFromCapabilities } from './capability-prefs';

describe('persistedPrefsFromCapabilities', () => {
  it('persists canonical permission reports', () => {
    expect(persistedPrefsFromCapabilities({
      permissionControl: { strategy: 'shelf' },
      currentPermissionMode: 'plan',
    }, { permissionMode: 'default' })).toEqual({ permissionMode: 'plan' });
  });

  it('never persists native permission state into the canonical Shelf preference', () => {
    expect(persistedPrefsFromCapabilities({
      permissionControl: { strategy: 'native' },
      currentPermissionMode: 'bypassPermissions',
    }, { permissionMode: 'default' })).toEqual({});
  });

  it('persists provider-native mode and permission as independent preferences', () => {
    expect(persistedPrefsFromCapabilities({
      permissionControl: {
        strategy: 'native',
        mode: {
          label: 'Mode',
          currentValue: 'autopilot',
          options: [{ value: 'autopilot', displayName: 'Autopilot' }],
        },
        permission: {
          label: 'Allow all',
          currentValue: 'on',
          options: [{ value: 'on', displayName: 'On' }],
        },
      },
    }, {
      permissionMode: 'default',
      nativeMode: 'agent',
      nativePermission: 'off',
    })).toEqual({
      nativeMode: 'autopilot',
      nativePermission: 'on',
    });
  });

  it('does not clear saved native preferences when a control is omitted', () => {
    expect(persistedPrefsFromCapabilities({
      permissionControl: { strategy: 'native' },
    }, {
      nativeMode: 'agent',
      nativePermission: 'off',
    })).toEqual({});
  });
});
