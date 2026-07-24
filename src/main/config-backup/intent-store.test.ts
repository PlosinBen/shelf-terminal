import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Machine-local backup intent: the pre-tick set is our own choice, persisted to
 * <userData>/config-backup-intent.json — never re-derived from the remote.
 */

let userDataDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

const { loadIntent, saveIntent, clearIntent } = await import('./intent-store');

const intentFile = () => path.join(userDataDir, 'config-backup-intent.json');

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-intent-'));
});
afterEach(() => {
  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('config-backup intent-store', () => {
  it('never backed up → []', () => {
    expect(loadIntent()).toEqual([]);
  });

  it('round-trips the chosen ids (deduped + sorted)', () => {
    saveIntent(['skill:beta', 'mcp:fs', 'skill:beta', 'skill:alpha']);
    expect(loadIntent()).toEqual(['mcp:fs', 'skill:alpha', 'skill:beta']);
  });

  it('clear removes the intent (missing = no-op)', () => {
    saveIntent(['skill:alpha']);
    clearIntent();
    expect(loadIntent()).toEqual([]);
    expect(() => clearIntent()).not.toThrow();
  });

  it('corrupt file → [] (fail-loud, no crash)', () => {
    fs.writeFileSync(intentFile(), 'not json');
    expect(loadIntent()).toEqual([]);
  });

  it('wrong shape (not a string array) → []', () => {
    fs.writeFileSync(intentFile(), JSON.stringify({ ids: ['skill:alpha'] }));
    expect(loadIntent()).toEqual([]);
  });
});
