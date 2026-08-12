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
});
