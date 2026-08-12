import { describe, expect, it } from 'vitest';
import { permissionControlViews } from './permission-control-view';

describe('permissionControlViews', () => {
  it('keeps the Shelf canonical permission picker as one control', () => {
    expect(permissionControlViews({
      permissionModes: [
        { value: 'default', displayName: 'ask' },
        { value: 'plan', displayName: 'plan' },
      ],
      currentPermissionMode: 'plan',
      permissionControl: { strategy: 'shelf' },
    })).toEqual([{
      key: 'permissionMode',
      label: 'Permission mode',
      currentValue: 'plan',
      options: [
        { value: 'default', displayName: 'ask' },
        { value: 'plan', displayName: 'plan' },
      ],
    }]);
  });

  it('returns independent native mode and permission controls in provider order', () => {
    expect(permissionControlViews({
      permissionModes: [],
      permissionControl: {
        strategy: 'native',
        mode: {
          label: 'Mode',
          currentValue: 'agent',
          options: [{ value: 'agent', displayName: 'Agent' }],
        },
        permission: {
          label: 'Allow all',
          currentValue: 'off',
          options: [{ value: 'off', displayName: 'Off' }],
        },
      },
    })).toEqual([
      {
        key: 'nativeMode',
        label: 'Mode',
        currentValue: 'agent',
        options: [{ value: 'agent', displayName: 'Agent' }],
      },
      {
        key: 'nativePermission',
        label: 'Allow all',
        currentValue: 'off',
        options: [{ value: 'off', displayName: 'Off' }],
      },
    ]);
  });
});
