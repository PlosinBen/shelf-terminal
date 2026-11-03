import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMsg } from '../components/AgentMessage';

type Row = AgentMsg & { dbId: number; sessionId: string };

const fakeIdb = vi.hoisted(() => {
  const rows: Row[] = [];
  const cleanup = new Map<string, { sessionId: string; projectId: string }>();
  let nextDbId = 1;

  function cursorFor(sessionId: string, offset = 0): any {
    const matches = rows.filter((row) => row.sessionId === sessionId);
    const row = matches[offset];
    if (!row) return null;
    return {
      value: row,
      primaryKey: row.dbId,
      delete: async () => {
        const index = rows.findIndex((candidate) => candidate.dbId === row.dbId);
        if (index >= 0) rows.splice(index, 1);
      },
      continue: async () => cursorFor(sessionId, offset + 1),
    };
  }

  const store = {
    index: () => ({ openCursor: async (sessionId: string) => cursorFor(sessionId), getAllKeys: async (sessionId: string) => rows.filter(row => row.sessionId === sessionId).map(row => row.dbId) }),
    delete: vi.fn(async (id: number) => { const index = rows.findIndex(row => row.dbId === id); if (index >= 0) rows.splice(index, 1); }),
    add: async (value: Omit<Row, 'dbId'>) => {
      const dbId = nextDbId++;
      rows.push({ ...value, dbId } as Row);
      return dbId;
    },
    put: async (value: Row) => {
      const index = rows.findIndex((candidate) => candidate.dbId === value.dbId);
      if (index >= 0) rows[index] = value;
      else rows.push(value);
    },
  };

  return {
    rows,
    cleanup,
    store,
    reset() {
      rows.splice(0);
      cleanup.clear();
      store.delete.mockClear();
      nextDbId = 1;
    },
    db: {
      getAll: async () => [...cleanup.values()],
      transaction: () => ({ objectStore: (name: string) => name === 'messages' ? store : {
        put: async (value: { sessionId: string; projectId: string }) => cleanup.set(value.sessionId, value),
        get: async (sessionId: string) => cleanup.get(sessionId),
        getAll: async () => [...cleanup.values()],
        delete: async (sessionId: string) => { cleanup.delete(sessionId); },
      }, done: Promise.resolve() }),
    },
  };
});

vi.mock('idb', () => ({ openDB: vi.fn(async () => fakeIdb.db) }));

import { saveAgentMessagesDelta, queueAgentHistoryCleanup, loadAgentHistoryCleanup, clearAgentSession, completeAgentHistoryCleanup } from './agent-history';
import { openDB } from 'idb';

function reply(content: string): AgentMsg {
  return {
    id: 'reply-1',
    type: 'reply',
    content,
    streaming: false,
    provider: 'copilot',
    timestamp: 1000,
  };
}

describe('agent history persistence', () => {
  beforeEach(() => fakeIdb.reset());

  it('retains cleanup ownership when history deletion fails, and removes it only on successful retry', async () => {
    await saveAgentMessagesDelta('session-1', [reply('owned')]);
    await queueAgentHistoryCleanup('p', ['session-1']);
    fakeIdb.store.delete.mockRejectedValueOnce(new Error('IDB unavailable'));
    await expect(completeAgentHistoryCleanup('session-1')).rejects.toThrow('IDB unavailable');
    expect(await loadAgentHistoryCleanup()).toEqual([{ projectId: 'p', sessionId: 'session-1' }]);
    await completeAgentHistoryCleanup('session-1');
    expect(await loadAgentHistoryCleanup()).toEqual([]);
    expect(fakeIdb.rows).toEqual([]);
  });

  it('an in-View Clear History does not cancel a staged Project cleanup', async () => {
    await queueAgentHistoryCleanup('p', ['session-1']);
    await clearAgentSession('session-1');
    expect(await loadAgentHistoryCleanup()).toEqual([{ projectId: 'p', sessionId: 'session-1' }]);
  });

  it('adds cleanup metadata without destroying existing v4 messages', async () => {
    await saveAgentMessagesDelta('session-1', [reply('v4 history')]);
    const upgrade = vi.mocked(openDB).mock.calls[0][2]!.upgrade!;
    const db = { objectStoreNames: { contains: (name: string) => name === 'messages' },
      deleteObjectStore: vi.fn(), createObjectStore: vi.fn(() => ({ createIndex: vi.fn() })) };
    (upgrade as (db: unknown, oldVersion: number) => void)(db, 4);
    expect(db.deleteObjectStore).not.toHaveBeenCalled();
    expect(db.createObjectStore).toHaveBeenCalledExactlyOnceWith('pending-cleanup', { keyPath: 'sessionId' });
  });

  it('updates an existing session/message row instead of appending another snapshot', async () => {
    await saveAgentMessagesDelta('session-1', [reply('first')]);
    await saveAgentMessagesDelta('session-1', [reply('first plus late content')]);

    expect(fakeIdb.rows).toHaveLength(1);
    expect(fakeIdb.rows[0]).toMatchObject({
      sessionId: 'session-1',
      id: 'reply-1',
      content: 'first plus late content',
    });
  });

  it('keeps the same message id isolated between sessions', async () => {
    await saveAgentMessagesDelta('session-1', [reply('one')]);
    await saveAgentMessagesDelta('session-2', [reply('two')]);

    expect(fakeIdb.rows).toHaveLength(2);
    expect(fakeIdb.rows.map((row) => ({
      sessionId: row.sessionId,
      content: row.type === 'reply' ? row.content : '',
    }))).toEqual([
      { sessionId: 'session-1', content: 'one' },
      { sessionId: 'session-2', content: 'two' },
    ]);
  });
});
