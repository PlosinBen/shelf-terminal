import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMsg } from '../components/AgentMessage';

type Row = AgentMsg & { dbId: number; sessionId: string };

const fakeIdb = vi.hoisted(() => {
  const rows: Row[] = [];
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
    index: () => ({ openCursor: async (sessionId: string) => cursorFor(sessionId) }),
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
    reset() {
      rows.splice(0);
      nextDbId = 1;
    },
    db: {
      transaction: () => ({ objectStore: () => store, done: Promise.resolve() }),
    },
  };
});

vi.mock('idb', () => ({ openDB: async () => fakeIdb.db }));

import { saveAgentMessagesDelta } from './agent-history';

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
