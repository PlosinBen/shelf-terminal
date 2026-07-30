import { describe, it, expect, afterEach } from 'vitest';
import { CLAUDE_PROVIDER, COPILOT_PROVIDER } from '@shared/agent-providers';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadContext, saveContext, deleteContext, type PersistedContext } from './context-store';

// Tests run against the real `~/.shelf/agent-context/` dir — UUID sessionIds
// guarantee zero collision with the user's real data, and `afterEach` cleans
// up. Refactoring the path is overkill for a single round-trip test.
function ctxPath(sessionId: string): string {
  return join(homedir(), '.shelf', 'agent-context', `${sessionId}.json`);
}

describe('context-store', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const id of created) {
      try {
        if (existsSync(ctxPath(id))) unlinkSync(ctxPath(id));
      } catch { /* ignore */ }
    }
    created.length = 0;
  });

  it('round-trips a Claude resume pointer', () => {
    const sessionId = randomUUID();
    created.push(sessionId);

    const data: PersistedContext = {
      sessionId,
      provider: CLAUDE_PROVIDER,
      lastSdkSessionId: 'sdk-session-abc-123',
      updatedAt: 1_700_000_000_000,
    };
    saveContext(data);

    const loaded = loadContext(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.lastSdkSessionId).toBe('sdk-session-abc-123');
    expect(loaded?.provider).toBe(CLAUDE_PROVIDER);
    // Copilot-only fields should remain absent (we made them optional).
    expect(loaded?.modelMessages).toBeUndefined();
    expect(loaded?.lastResponseId).toBeUndefined();
  });

  it('round-trips a Copilot Responses chain pointer', () => {
    const sessionId = randomUUID();
    created.push(sessionId);

    const data: PersistedContext = {
      sessionId,
      provider: COPILOT_PROVIDER,
      lastResponseId: 'resp_abc',
      modelMessages: [{ role: 'user', content: 'hi' }],
      totalInputTokens: 12,
      totalOutputTokens: 34,
      model: 'gpt-5',
      updatedAt: 1_700_000_000_000,
    };
    saveContext(data);

    const loaded = loadContext(sessionId);
    expect(loaded?.lastResponseId).toBe('resp_abc');
    expect(loaded?.modelMessages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(loaded?.totalInputTokens).toBe(12);
  });

  it('returns null for unknown sessionId', () => {
    expect(loadContext(randomUUID())).toBeNull();
  });

  it('deleteContext removes the file (and is idempotent)', () => {
    const sessionId = randomUUID();
    created.push(sessionId);

    saveContext({
      sessionId,
      provider: CLAUDE_PROVIDER,
      lastSdkSessionId: 'x',
      updatedAt: Date.now(),
    });
    expect(loadContext(sessionId)).not.toBeNull();

    deleteContext(sessionId);
    expect(loadContext(sessionId)).toBeNull();

    // Second delete on missing file should not throw.
    expect(() => deleteContext(sessionId)).not.toThrow();
  });
});
