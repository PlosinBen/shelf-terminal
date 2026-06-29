import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServerConfig, McpStdioServer } from '@shared/mcp';

let tmpDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));

const {
  isValidMcpServerName, validateMcpServer,
  listMcpServers, getMcpServer, addMcpServer, updateMcpServer, removeMcpServer,
} = await import('./mcp-store');

const configFile = () => path.join(tmpDir, 'mcp-servers.json');
const stdio = (name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ type: 'stdio', name, command: 'node', ...extra } as McpServerConfig);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-mcp-store-'));
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pure validators', () => {
  it('isValidMcpServerName allows clean identifiers, rejects path/space chars', () => {
    expect(isValidMcpServerName('github')).toBe(true);
    expect(isValidMcpServerName('my_server-2.0')).toBe(true);
    expect(isValidMcpServerName('has space')).toBe(false);
    expect(isValidMcpServerName('a/b')).toBe(false);
    expect(isValidMcpServerName('')).toBe(false);
    expect(isValidMcpServerName('-leading')).toBe(false);
    expect(isValidMcpServerName(42)).toBe(false);
  });

  it('validateMcpServer accepts stdio + http, rejects bad shapes', () => {
    expect(validateMcpServer({ type: 'stdio', name: 'a', command: 'node' })).toBeNull();
    expect(validateMcpServer({ type: 'stdio', name: 'a', command: 'node', args: ['x'], env: { K: 'v' } })).toBeNull();
    expect(validateMcpServer({ type: 'http', name: 'a', url: 'https://x', headers: { A: 'b' } })).toBeNull();

    expect(validateMcpServer({ type: 'stdio', name: 'a' })).toMatch(/command/);
    expect(validateMcpServer({ type: 'stdio', name: 'bad name', command: 'x' })).toMatch(/name/);
    expect(validateMcpServer({ type: 'http', name: 'a' })).toMatch(/url/);
    expect(validateMcpServer({ type: 'stdio', name: 'a', command: 'x', env: { K: 1 } })).toMatch(/env/);
    expect(validateMcpServer({ type: 'mystery', name: 'a' })).toMatch(/Unknown server type/);
    expect(validateMcpServer(null)).toMatch(/object/);
  });
});

describe('CRUD over mcp-servers.json', () => {
  it('add → list → get round-trips, sorted by name', () => {
    expect(addMcpServer(stdio('beta')).ok).toBe(true);
    expect(addMcpServer(stdio('alpha')).ok).toBe(true);
    expect(listMcpServers().map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(getMcpServer('alpha')?.name).toBe('alpha');
    expect(getMcpServer('missing')).toBeNull();
    // persisted as a top-level array
    expect(Array.isArray(JSON.parse(fs.readFileSync(configFile(), 'utf-8')))).toBe(true);
  });

  it('add rejects a duplicate name and an invalid shape', () => {
    addMcpServer(stdio('a'));
    expect(addMcpServer(stdio('a')).error).toMatch(/already exists/);
    expect(addMcpServer({ type: 'stdio', name: 'b' } as McpServerConfig).error).toMatch(/command/);
  });

  it('update replaces in place; rename collision-checks', () => {
    addMcpServer(stdio('a', { command: 'node' }));
    addMcpServer(stdio('b'));
    // in-place edit
    expect(updateMcpServer('a', stdio('a', { command: 'python' })).ok).toBe(true);
    expect((getMcpServer('a') as McpStdioServer | null)?.command).toBe('python');
    // rename a → c
    expect(updateMcpServer('a', stdio('c')).ok).toBe(true);
    expect(getMcpServer('a')).toBeNull();
    expect(getMcpServer('c')?.name).toBe('c');
    // rename onto an existing name fails
    expect(updateMcpServer('c', stdio('b')).error).toMatch(/already exists/);
    // updating a missing server fails
    expect(updateMcpServer('nope', stdio('nope')).error).toMatch(/not found/);
  });

  it('remove drops the server; missing remove is a no-op', () => {
    addMcpServer(stdio('a'));
    addMcpServer(stdio('b'));
    removeMcpServer('a');
    expect(listMcpServers().map((s) => s.name)).toEqual(['b']);
    expect(() => removeMcpServer('ghost')).not.toThrow();
  });

  it('missing file = empty list; corrupt JSON = empty (fail-loud, no crash)', () => {
    expect(listMcpServers()).toEqual([]);
    fs.writeFileSync(configFile(), '{ not json', 'utf-8');
    expect(listMcpServers()).toEqual([]);
    fs.writeFileSync(configFile(), '{"a":1}', 'utf-8'); // not an array
    expect(listMcpServers()).toEqual([]);
  });

  it('list filters out entries that fail validation (opaque to good ones)', () => {
    fs.writeFileSync(configFile(), JSON.stringify([
      { type: 'stdio', name: 'good', command: 'node' },
      { type: 'stdio', name: 'bad name', command: 'x' },
    ]), 'utf-8');
    expect(listMcpServers().map((s) => s.name)).toEqual(['good']);
  });
});
