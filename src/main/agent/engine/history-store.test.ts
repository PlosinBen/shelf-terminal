import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createFileHistoryStore, type EngineHistory } from './history-store';

function makeEntry(overrides: Partial<EngineHistory> = {}): EngineHistory {
  const now = Date.now();
  return {
    version: 1,
    sessionId: 'test-session-001',
    providerName: 'test',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('createFileHistoryStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-hist-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null when the session file does not exist', async () => {
    const store = createFileHistoryStore({ dir });
    expect(await store.load('never-written')).toBeNull();
  });

  it('round-trips save → load for a simple entry', async () => {
    const store = createFileHistoryStore({ dir });
    const entry = makeEntry();
    await store.save(entry);
    const loaded = await store.load(entry.sessionId);
    expect(loaded).toEqual(entry);
  });

  it('overwrites the previous file on repeat save (atomic rename)', async () => {
    const store = createFileHistoryStore({ dir });
    await store.save(makeEntry({ messages: [{ role: 'user', content: 'first' }] }));
    await store.save(makeEntry({ messages: [{ role: 'user', content: 'second' }] }));
    const loaded = await store.load('test-session-001');
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'second' }]);
  });

  it('does not leave a .tmp file behind after successful save', async () => {
    const store = createFileHistoryStore({ dir });
    await store.save(makeEntry());
    const files = await fs.readdir(dir);
    expect(files).toContain('test-session-001.json');
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('delete removes the file', async () => {
    const store = createFileHistoryStore({ dir });
    await store.save(makeEntry());
    await store.delete('test-session-001');
    expect(await store.load('test-session-001')).toBeNull();
  });

  it('delete is a no-op when file does not exist', async () => {
    const store = createFileHistoryStore({ dir });
    // Must not throw.
    await expect(store.delete('never-written')).resolves.toBeUndefined();
  });

  it('creates the target directory lazily on first save', async () => {
    const nested = path.join(dir, 'nested', 'subdir');
    const store = createFileHistoryStore({ dir: nested });
    await store.save(makeEntry());
    const files = await fs.readdir(nested);
    expect(files).toContain('test-session-001.json');
  });

  it('ignores entries with an unknown schema version (returns null)', async () => {
    const store = createFileHistoryStore({ dir });
    // Write a file directly with a bogus version — simulates a downgrade
    // after a future app wrote v2.
    await fs.writeFile(path.join(dir, 'future.json'), JSON.stringify({ version: 99, sessionId: 'future', messages: [] }));
    expect(await store.load('future')).toBeNull();
  });

  it('returns null on corrupted JSON instead of throwing', async () => {
    const store = createFileHistoryStore({ dir });
    await fs.writeFile(path.join(dir, 'broken.json'), '{not json');
    expect(await store.load('broken')).toBeNull();
  });

  it('rejects unsafe sessionIds to prevent path traversal', async () => {
    const store = createFileHistoryStore({ dir });
    // All of these would escape or corrupt the agent-state dir if not guarded.
    const bad = ['../escape', 'a/b', '..', 'has space', ''];
    for (const id of bad) {
      // load/delete swallow the error (return null / no-op); save no-ops.
      // Make sure none of them actually create a file.
      expect(await store.load(id)).toBeNull();
      await store.save(makeEntry({ sessionId: id }));
      await store.delete(id);
    }
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(0);
  });
});
