import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServerBlock, McpStdioBlock } from '@shared/mcp';

let tmpDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));

const {
  isValidMcpServerName, validateMcpServerBlock, validateMcpEntry,
  listMcpServers, getMcpServer, addMcpServer, updateMcpServer, removeMcpServer,
} = await import('./mcp-store');

const configFile = () => path.join(tmpDir, 'mcp-servers.json');
const stdio = (extra: Partial<McpStdioBlock> = {}): McpServerBlock =>
  ({ type: 'stdio', command: 'node', ...extra } as McpServerBlock);

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

  it('validateMcpServerBlock accepts stdio + http blocks (no name), rejects bad shapes', () => {
    expect(validateMcpServerBlock({ type: 'stdio', command: 'node' })).toBeNull();
    expect(validateMcpServerBlock({ type: 'stdio', command: 'node', args: ['x'], env: { K: 'v' } })).toBeNull();
    expect(validateMcpServerBlock({ type: 'http', url: 'https://x', headers: { A: 'b' } })).toBeNull();

    expect(validateMcpServerBlock({ type: 'stdio' })).toMatch(/command/);
    expect(validateMcpServerBlock({ type: 'http' })).toMatch(/url/);
    expect(validateMcpServerBlock({ type: 'stdio', command: 'x', env: { K: 1 } })).toMatch(/env/);
    expect(validateMcpServerBlock({ type: 'mystery' })).toMatch(/Unknown server type/);
    expect(validateMcpServerBlock(null)).toMatch(/object/);
  });

  it('validateMcpEntry checks the name key too', () => {
    expect(validateMcpEntry('ok', { type: 'stdio', command: 'node' })).toBeNull();
    expect(validateMcpEntry('bad name', { type: 'stdio', command: 'node' })).toMatch(/name/);
  });
});

describe('CRUD over mcp-servers.json (keyed object)', () => {
  it('add → list → get round-trips; persisted as a keyed object, sorted', () => {
    expect(addMcpServer('beta', stdio()).ok).toBe(true);
    expect(addMcpServer('alpha', stdio()).ok).toBe(true);
    expect(Object.keys(listMcpServers())).toEqual(['alpha', 'beta']);
    expect(getMcpServer('alpha')?.type).toBe('stdio');
    expect(getMcpServer('missing')).toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(Array.isArray(onDisk)).toBe(false);
    expect(Object.keys(onDisk)).toEqual(['alpha', 'beta']); // sorted keys
  });

  it('add rejects a duplicate name and an invalid shape', () => {
    addMcpServer('a', stdio());
    expect(addMcpServer('a', stdio()).error).toMatch(/already exists/);
    expect(addMcpServer('b', { type: 'stdio' } as McpServerBlock).error).toMatch(/command/);
    expect(addMcpServer('bad name', stdio()).error).toMatch(/name/);
  });

  it('update edits in place; rename via nextName collision-checks', () => {
    addMcpServer('a', stdio({ command: 'node' }));
    addMcpServer('b', stdio());
    // in-place edit
    expect(updateMcpServer('a', stdio({ command: 'python' })).ok).toBe(true);
    expect((getMcpServer('a') as McpStdioBlock | null)?.command).toBe('python');
    // rename a → c
    expect(updateMcpServer('a', stdio(), 'c').ok).toBe(true);
    expect(getMcpServer('a')).toBeNull();
    expect(getMcpServer('c')?.type).toBe('stdio');
    // rename onto an existing name fails
    expect(updateMcpServer('c', stdio(), 'b').error).toMatch(/already exists/);
    // updating a missing server fails
    expect(updateMcpServer('nope', stdio()).error).toMatch(/not found/);
  });

  it('remove drops the server; missing remove is a no-op', () => {
    addMcpServer('a', stdio());
    addMcpServer('b', stdio());
    removeMcpServer('a');
    expect(Object.keys(listMcpServers())).toEqual(['b']);
    expect(() => removeMcpServer('ghost')).not.toThrow();
  });

  it('missing file = empty; corrupt JSON / array = empty (fail-loud, no crash)', () => {
    expect(listMcpServers()).toEqual({});
    fs.writeFileSync(configFile(), '{ not json', 'utf-8');
    expect(listMcpServers()).toEqual({});
    fs.writeFileSync(configFile(), '[1,2]', 'utf-8'); // array, not keyed object
    expect(listMcpServers()).toEqual({});
  });

  it('list filters out entries that fail validation (opaque to good ones)', () => {
    fs.writeFileSync(configFile(), JSON.stringify({
      good: { type: 'stdio', command: 'node' },
      'bad name': { type: 'stdio', command: 'x' },
      badshape: { type: 'stdio' },
    }), 'utf-8');
    expect(Object.keys(listMcpServers())).toEqual(['good']);
  });
});
