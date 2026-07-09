import { describe, it, expect } from 'vitest';
import {
  isReservedEnvKey,
  validateEnvKey,
  sanitizeEnvMap,
  applyEnvMap,
  buildEnvExportPrefix,
} from './project-env';

describe('isReservedEnvKey', () => {
  it('reserves the SHELF_ prefix and specific Shelf-owned keys', () => {
    expect(isReservedEnvKey('SHELF_TEST_MODE')).toBe(true);
    expect(isReservedEnvKey('SHELF_ANYTHING_NEW')).toBe(true); // new SHELF_* auto-reserved
    expect(isReservedEnvKey('ELECTRON_RUN_AS_NODE')).toBe(true);
  });
  it('leaves ordinary vars settable', () => {
    expect(isReservedEnvKey('GH_TOKEN')).toBe(false);
    expect(isReservedEnvKey('PATH')).toBe(false);
    expect(isReservedEnvKey('HTTPS_PROXY')).toBe(false);
  });
});

describe('validateEnvKey', () => {
  it('accepts a valid, unique, non-reserved key', () => {
    expect(validateEnvKey('GH_TOKEN', ['HTTPS_PROXY'])).toBeNull();
  });
  it('treats a blank key as not-yet-an-error (row being typed)', () => {
    expect(validateEnvKey('')).toBeNull();
  });
  it('rejects malformed names', () => {
    expect(validateEnvKey('1BAD')).toBe('Invalid variable name');
    expect(validateEnvKey('has space')).toBe('Invalid variable name');
    expect(validateEnvKey('has-dash')).toBe('Invalid variable name');
  });
  it('rejects reserved keys', () => {
    expect(validateEnvKey('SHELF_FOO')).toBe('Reserved by Shelf');
    expect(validateEnvKey('ELECTRON_RUN_AS_NODE')).toBe('Reserved by Shelf');
  });
  it('rejects a duplicate across plain+secret', () => {
    expect(validateEnvKey('GH_TOKEN', ['GH_TOKEN'])).toBe('Duplicate variable');
  });
});

describe('sanitizeEnvMap', () => {
  it('drops reserved keys, bad names, and non-string values', () => {
    expect(sanitizeEnvMap({
      GH_TOKEN: 'abc',
      SHELF_TEST_MODE: '1',
      ELECTRON_RUN_AS_NODE: '1',
      'bad key': 'x',
      NUM: 42 as any,
      OK: 'yes',
    })).toEqual({ GH_TOKEN: 'abc', OK: 'yes' });
  });
  it('returns {} for nullish input', () => {
    expect(sanitizeEnvMap(undefined)).toEqual({});
    expect(sanitizeEnvMap(null)).toEqual({});
  });
});

describe('applyEnvMap', () => {
  it('overrides ambient silently and drops undefined base values', () => {
    expect(applyEnvMap({ FOO: 'ambient', BAR: undefined }, { FOO: 'project' }))
      .toEqual({ FOO: 'project' });
  });
  it('merges PATH (project prepended) instead of replacing', () => {
    expect(applyEnvMap({ PATH: '/usr/bin' }, { PATH: '/opt/bin' }))
      .toEqual({ PATH: '/opt/bin:/usr/bin' });
  });
  it('uses project PATH alone when base has none', () => {
    expect(applyEnvMap({}, { PATH: '/opt/bin' })).toEqual({ PATH: '/opt/bin' });
  });
  it('ignores reserved keys in the project map (backstop)', () => {
    expect(applyEnvMap({ A: '1' }, { SHELF_X: 'y', ELECTRON_RUN_AS_NODE: '0', B: '2' }))
      .toEqual({ A: '1', B: '2' });
  });
});

describe('buildEnvExportPrefix', () => {
  it('returns an empty prefix for an empty map', () => {
    expect(buildEnvExportPrefix({})).toBe('');
  });
  it('emits single-quoted exports terminated with "; "', () => {
    expect(buildEnvExportPrefix({ GH_TOKEN: 'abc' })).toBe("export GH_TOKEN='abc'; ");
  });
  it('escapes embedded single quotes', () => {
    expect(buildEnvExportPrefix({ MSG: "it's" })).toBe("export MSG='it'\\''s'; ");
  });
  it('merges PATH against the target $PATH', () => {
    expect(buildEnvExportPrefix({ PATH: '/opt/bin' })).toBe(`export PATH='/opt/bin':"$PATH"; `);
  });
  it('drops reserved keys', () => {
    expect(buildEnvExportPrefix({ SHELF_X: '1', OK: 'v' })).toBe("export OK='v'; ");
  });
});
