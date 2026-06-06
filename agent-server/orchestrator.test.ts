import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadContext, saveContext } from './context-store';
import { loadRestoreContextFor, newTurnId, wrapSendForContext, wrapSendForTurn } from './orchestrator';
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
      send({ type: 'message', msgId: 'm-1', msgType: 'reply', content: 'hi' });
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
      send({ type: 'context_patch', patch: {} });
      const ctx = loadContext(sessionId);
      expect(ctx?.provider).toBe('claude');
      expect(ctx?.sessionId).toBe(sessionId);
      expect(ctx?.updatedAt).toBe(42);
    });
  });

  describe('newTurnId', () => {
    it('produces `t-` prefixed 10-char ids', () => {
      const id = newTurnId();
      expect(id).toMatch(/^t-[0-9a-f]{8}$/);
    });

    it('yields a fresh id on each call (no collisions in 1k samples)', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) ids.add(newTurnId());
      expect(ids.size).toBe(1000);
    });
  });

  describe('wrapSendForTurn', () => {
    it('stamps turnId onto every forwarded message', () => {
      const seen: OutgoingMessage[] = [];
      const send = wrapSendForTurn('t-abc12345', (m) => seen.push(m));
      send({ type: 'status', state: 'streaming' });
      send({ type: 'message', msgId: 'm-1', msgType: 'reply', content: 'hi' });
      expect(seen).toEqual([
        { type: 'status', state: 'streaming', turnId: 't-abc12345' },
        { type: 'message', msgId: 'm-1', msgType: 'reply', content: 'hi', turnId: 't-abc12345' },
      ]);
    });

    it('does NOT stamp turnId onto task_event (backgrounded task outlives its turn)', () => {
      const seen: OutgoingMessage[] = [];
      const send = wrapSendForTurn('t-abc12345', (m) => seen.push(m));
      send({
        type: 'task_event',
        kind: 'started',
        task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'running', done: false },
      });
      // Passed through verbatim — no turnId injected, else the main-side
      // dispatcher would drop it as "unknown turn" once the turn is idle.
      expect(seen).toHaveLength(1);
      expect((seen[0] as any).turnId).toBeUndefined();
      expect(seen[0]).toEqual({
        type: 'task_event',
        kind: 'started',
        task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'running', done: false },
      });
    });

    it('different turn wrappers stamp different ids (independent state)', () => {
      const seen: OutgoingMessage[] = [];
      const raw = (m: OutgoingMessage) => seen.push(m);
      const a = wrapSendForTurn('t-aaaaaaaa', raw);
      const b = wrapSendForTurn('t-bbbbbbbb', raw);
      a({ type: 'status', state: 'streaming' });
      b({ type: 'status', state: 'idle' });
      expect((seen[0] as any).turnId).toBe('t-aaaaaaaa');
      expect((seen[1] as any).turnId).toBe('t-bbbbbbbb');
    });

    it('composes with wrapSendForContext: context_patch is intercepted before turnId injection so the disk write is untainted', () => {
      const sessionId = randomUUID();
      created.push(sessionId);
      const seen: OutgoingMessage[] = [];
      const raw = (m: OutgoingMessage) => seen.push(m);
      const turnAware = wrapSendForTurn('t-99999999', raw);
      const contextAware = wrapSendForContext('claude', sessionId, turnAware, () => 7);
      // context_patch never reaches turnAware → no turnId pollution in stored context
      contextAware({ type: 'context_patch', patch: { lastSdkSessionId: 'sdk-1' } });
      expect(seen).toHaveLength(0);
      const ctx = loadContext(sessionId);
      expect(ctx?.lastSdkSessionId).toBe('sdk-1');
      expect((ctx as any)?.turnId).toBeUndefined();
      // Non-patch goes through both wrappers and acquires turnId
      contextAware({ type: 'status', state: 'streaming' });
      expect(seen).toEqual([
        { type: 'status', state: 'streaming', turnId: 't-99999999' },
      ]);
    });
  });
});
