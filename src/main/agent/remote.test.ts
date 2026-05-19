import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/mock/app',
    isPackaged: false,
  },
}));

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('{"version":"1.0.0"}'),
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  ChildProcess: class {},
}));

// Mock logger
vi.mock('@shared/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(), flushTrace: vi.fn() },
}));

describe('toWslPath', () => {
  it('converts Windows drive paths to WSL mount paths', async () => {
    const { toWslPath } = await import('./remote');
    expect(toWslPath('C:\\Users\\ben\\app\\resources\\agent-server\\1.2.3\\index.mjs'))
      .toBe('/mnt/c/Users/ben/app/resources/agent-server/1.2.3/index.mjs');
  });

  it('handles lowercase drive letters', async () => {
    const { toWslPath } = await import('./remote');
    expect(toWslPath('c:\\foo\\bar')).toBe('/mnt/c/foo/bar');
  });

  it('handles other drive letters', async () => {
    const { toWslPath } = await import('./remote');
    expect(toWslPath('D:\\Program Files\\Shelf')).toBe('/mnt/d/Program Files/Shelf');
  });
});

describe('remote backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('can be imported without errors', async () => {
    const mod = await import('./remote');
    expect(mod.createRemoteBackend).toBeDefined();
  });

  it('createRemoteBackend returns an AgentBackend interface', async () => {
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    expect(backend).toHaveProperty('query');
    expect(backend).toHaveProperty('stop');
    expect(backend).toHaveProperty('dispose');
    expect(backend).toHaveProperty('checkAuth');
    // setModel/setEffort/setPermissionMode removed — renderer now passes
    // prefs in each AGENT_SEND payload; orchestrator on the agent-server
    // side drives diff detection and calls provider.setX as needed.
  });

  it('checkAuth returns true', async () => {
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    const result = await backend.checkAuth();
    expect(result).toBe(true);
  });

  it('dispose does not throw when no process exists', async () => {
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    expect(() => backend.dispose()).not.toThrow();
  });

});
