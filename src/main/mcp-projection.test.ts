import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let userDataDir: string;
let homeDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => homeDir }, homedir: () => homeDir };
});

const { projectMcpLocal, localMcpTarget, mcpConfigSourcePath, hashMcpConfig } = await import('./mcp-projection');

function seedConfig(body: string) {
  fs.writeFileSync(path.join(userDataDir, 'mcp-servers.json'), body);
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-mcpproj-ud-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-mcpproj-home-'));
});
afterEach(() => {
  for (const d of [userDataDir, homeDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
});

describe('projectMcpLocal', () => {
  it('copies the config onto ~/.shelf/apps/<id>/mcp-servers.json + touches .heartbeat', () => {
    seedConfig('[{"type":"stdio","name":"a","command":"node"}]');
    projectMcpLocal('app-123');
    const dst = localMcpTarget('app-123');
    expect(dst).toBe(path.join(homeDir, '.shelf', 'apps', 'app-123', 'mcp-servers.json'));
    expect(fs.readFileSync(dst, 'utf-8')).toBe('[{"type":"stdio","name":"a","command":"node"}]');
    // shares the app lease so the startup sweep doesn't reclaim the dir
    expect(fs.existsSync(path.join(homeDir, '.shelf', 'apps', 'app-123', '.heartbeat'))).toBe(true);
  });

  it('no-ops when there is no source (user configured no servers)', () => {
    expect(() => projectMcpLocal('app-x')).not.toThrow();
    expect(fs.existsSync(localMcpTarget('app-x'))).toBe(false);
  });

  it('re-projection overwrites the target with the latest source', () => {
    seedConfig('[1]');
    projectMcpLocal('app-1');
    seedConfig('[2]');
    projectMcpLocal('app-1');
    expect(fs.readFileSync(localMcpTarget('app-1'), 'utf-8')).toBe('[2]');
  });
});

describe('hashMcpConfig', () => {
  it('is stable across calls and changes with content; empty for no source', () => {
    expect(hashMcpConfig(mcpConfigSourcePath())).toBe(''); // no file yet
    seedConfig('[{"name":"a"}]');
    const h1 = hashMcpConfig(mcpConfigSourcePath());
    expect(h1).not.toBe('');
    expect(hashMcpConfig(mcpConfigSourcePath())).toBe(h1); // stable
    seedConfig('[{"name":"a"},{"name":"b"}]');
    expect(hashMcpConfig(mcpConfigSourcePath())).not.toBe(h1); // content change perturbs
  });
});
