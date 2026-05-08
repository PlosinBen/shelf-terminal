import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadContext, saveContext } from './context-store';
import { loadRestoreContextFor, wrapSendForContext } from './orchestrator';
import type { OutgoingMessage } from './providers/types';

// Mirror context-store.test.ts: real FS, UUID sessionIds for collision-free
// isolation, afterEach cleanup. Avoiding fs mocks keeps these tests honest
// about atomic write / merge behaviour.
function ctxPath(sessionId: string): string {
  return join(homedir(), '.shelf', 'agent-context', `${sessionId}.json`);
}

describe('orchestrator', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const id of created) {
      try { if (existsSync(ctxPath(id))) unlinkSync(ctxPath(id)); } catch { /* ignore */ }
    }
    created.length = 0;
  });

  describe('loadRestoreContextFor', () => {
    it('returns the stored context when provider matches', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      saveContext({
        sessionId, provider: 'claude',
        lastSdkSessionId: 'sdk-x',
        updatedAt: 1,
      });
      const ctx = loadRestoreContextFor('claude', sessionId);
      expect(ctx?.lastSdkSessionId).toBe('sdk-x');
    });

    it('returns undefined when provider does NOT match — prevents Claude data leaking into a Copilot turn', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      saveContext({
        sessionId, provider: 'claude',
        lastSdkSessionId: 'sdk-x',
        updatedAt: 1,
      });
      expect(loadRestoreContextFor('copilot', sessionId)).toBeUndefined();
    });

    it('returns undefined when sessionId is missing', () => {
      expect(loadRestoreContextFor('claude', undefined)).toBeUndefined();
    });

    it('returns undefined when no file exists', () => {
      expect(loadRestoreContextFor('claude', randomUUID())).toBeUndefined();
    });
  });

  describe('wrapSendForContext', () => {
    it('forwards non-context_patch messages unchanged', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      const seen: OutgoingMessage[] = [];
      const send = wrapSendForContext('claude', sessionId, (m) => seen.push(m));
      send({ type: 'status', state: 'streaming' });
      send({ type: 'message', msgType: 'text', content: 'hi' });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual({ type: 'status', state: 'streaming' });
    });

    it('intercepts context_patch and writes it to disk; does NOT forward', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      const seen: OutgoingMessage[] = [];
      const send = wrapSendForContext('claude', sessionId, (m) => seen.push(m), () => 12345);
      send({ type: 'context_patch', patch: { lastSdkSessionId: 'sdk-abc' } });
      expect(seen).toHaveLength(0);
      const ctx = loadContext(sessionId);
      expect(ctx?.lastSdkSessionId).toBe('sdk-abc');
      expect(ctx?.provider).toBe('claude');
      expect(ctx?.sessionId).toBe(sessionId);
      expect(ctx?.updatedAt).toBe(12345);
    });

    it('merges new patch fields with existing stored context', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      saveContext({
        sessionId, provider: 'claude',
        lastSdkSessionId: 'sdk-old',
        model: 'claude-sonnet-4',
        updatedAt: 1,
      });
      const send = wrapSendForContext('claude', sessionId, () => {}, () => 999);
      // Only patch lastSdkSessionId — `model` should survive.
      send({ type: 'context_patch', patch: { lastSdkSessionId: 'sdk-new' } });
      const ctx = loadContext(sessionId);
      expect(ctx?.lastSdkSessionId).toBe('sdk-new');
      expect(ctx?.model).toBe('claude-sonnet-4');
      expect(ctx?.updatedAt).toBe(999);
    });

    it('does not let provider patches override orchestrator-owned fields', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      const send = wrapSendForContext('copilot', sessionId, () => {}, () => 555);
      // Malicious / buggy provider tries to forge identity fields.
      send({
        type: 'context_patch',
        patch: {
          provider: 'claude',
          sessionId: 'forged',
          updatedAt: 1,
          lastSdkSessionId: 'cli-1',
        },
      });
      const ctx = loadContext(sessionId);
      expect(ctx?.provider).toBe('copilot');
      expect(ctx?.sessionId).toBe(sessionId);
      expect(ctx?.updatedAt).toBe(555);
      expect(ctx?.lastSdkSessionId).toBe('cli-1');
    });

    it('returns the raw send unchanged when sessionId is missing — patches with no destination are simply forwarded (and ignored downstream)', () => {
      const seen: OutgoingMessage[] = [];
      const raw = (m: OutgoingMessage) => seen.push(m);
      const send = wrapSendForContext('claude', undefined, raw);
      expect(send).toBe(raw);
      // And a context_patch through it is forwarded as-is (no disk write
      // because there's no sessionId to key on).
      send({ type: 'context_patch', patch: { lastSdkSessionId: 'x' } });
      expect(seen).toHaveLength(1);
    });

    it('treats missing patch field as empty object (no crash, just timestamp bump)', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      const send = wrapSendForContext('claude', sessionId, () => {}, () => 42);
      send({ type: 'context_patch' });
      const ctx = loadContext(sessionId);
      expect(ctx?.provider).toBe('claude');
      expect(ctx?.sessionId).toBe(sessionId);
      expect(ctx?.updatedAt).toBe(42);
    });
  });
});
