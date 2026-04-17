import { describe, it, expect, beforeEach, vi } from 'vitest';

const BASE_PATH = '/tmp/shelf-test-userdata';

let currentPath: string;
let isPackaged: boolean;
let hasUserDataDirSwitch: boolean;

const setPathSpy = vi.fn((_name: string, value: string) => {
  currentPath = value;
});

vi.mock('electron', () => ({
  app: {
    getPath: () => currentPath,
    setPath: (name: string, value: string) => setPathSpy(name, value),
    get isPackaged() {
      return isPackaged;
    },
    commandLine: {
      hasSwitch: (name: string) => name === 'user-data-dir' && hasUserDataDirSwitch,
    },
  },
}));

const { applyUserDataIsolation, __resetForTests } = await import('./user-data-path');

beforeEach(() => {
  currentPath = BASE_PATH;
  isPackaged = false;
  hasUserDataDirSwitch = false;
  setPathSpy.mockClear();
  __resetForTests();
});

describe('applyUserDataIsolation', () => {
  it('packaged app leaves userData at OS default', () => {
    isPackaged = true;
    applyUserDataIsolation();
    expect(setPathSpy).not.toHaveBeenCalled();
    expect(currentPath).toBe(BASE_PATH);
  });

  it('unpackaged + no --user-data-dir appends -dev', () => {
    applyUserDataIsolation();
    expect(setPathSpy).toHaveBeenCalledTimes(1);
    expect(currentPath).toBe(`${BASE_PATH}-dev`);
  });

  it('unpackaged + --user-data-dir leaves path alone', () => {
    hasUserDataDirSwitch = true;
    applyUserDataIsolation();
    expect(setPathSpy).not.toHaveBeenCalled();
    expect(currentPath).toBe(BASE_PATH);
  });

  it('packaged + --user-data-dir leaves path alone', () => {
    isPackaged = true;
    hasUserDataDirSwitch = true;
    applyUserDataIsolation();
    expect(setPathSpy).not.toHaveBeenCalled();
    expect(currentPath).toBe(BASE_PATH);
  });

  it('is idempotent — second call does not re-suffix', () => {
    applyUserDataIsolation();
    applyUserDataIsolation();
    expect(setPathSpy).toHaveBeenCalledTimes(1);
    expect(currentPath).toBe(`${BASE_PATH}-dev`);
  });
});
