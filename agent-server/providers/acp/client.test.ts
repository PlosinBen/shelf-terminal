import { describe, it, expect } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { createMockAcpAgent } from './mock-agent';
import { openAcpConnection } from './connection';
import { createSessionDriver } from './client';
import type { OutgoingMessage } from '../types';

// Exercises the toolkit runtime path end-to-end (connection + driver + turn)
// against the in-process mock agent — no stdio, no binary, no credentials.
describe('acp session driver (connection + new/resume + turn)', () => {
  it('drives a prompt turn: streams chunks + finalizes a reply + tool card', async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' }, messageId: 'm1' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' }, messageId: 'm1' },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'completed' },
    ];
    let promptSeen: unknown;
    const mock = createMockAcpAgent({ updatesOnPrompt: updates, onPrompt: (p) => { promptSeen = p; } });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { name: 'test', onSessionUpdate: driver.onSessionUpdate });

    const wire: OutgoingMessage[] = [];
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/proj' });
    const stopReason = await driver.drivePromptTurn(conn.agent, session, 'hi', (m) => wire.push(m));
    conn.close();

    expect(stopReason).toBe('end_turn');
    expect((promptSeen as { prompt?: unknown }).prompt).toBeTruthy();
    expect(wire).toEqual([
      { type: 'stream', msgId: 'm1', streamType: 'text', content: 'Hel' },
      { type: 'stream', msgId: 'm1', streamType: 'text', content: 'lo' },
      { type: 'message', msgId: 't1', msgType: 'fold_code', label: 'Read', subtitle: 'read' },
      { type: 'message', msgId: 'm1', msgType: 'reply', content: 'Hello' },
    ]);
  });

  it('passes additionalDirectories to session/new', async () => {
    let newParams: { additionalDirectories?: string[] } | undefined;
    const mock = createMockAcpAgent({ onNewSession: (p) => { newParams = p as typeof newParams; } });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p', additionalDirectories: ['/tmp/p/codex'] });
    expect(session.sessionId).toBe('mock-session');
    expect(newParams?.additionalDirectories).toEqual(['/tmp/p/codex']);
    conn.close();
  });

  it('resumes an existing session and drives a turn on it', async () => {
    const mock = createMockAcpAgent({
      updatesOnPrompt: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed' }, messageId: 'r1' }],
    });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.resume(conn.agent, 'mock-session', { cwd: '/tmp/p' });
    expect(session.sessionId).toBe('mock-session');
    expect(session.newSessionResponse).toBeUndefined();

    const wire: OutgoingMessage[] = [];
    const stop = await driver.drivePromptTurn(conn.agent, session, 'again', (m) => wire.push(m));
    conn.close();
    expect(stop).toBe('end_turn');
    expect(wire).toContainEqual({ type: 'message', msgId: 'r1', msgType: 'reply', content: 'resumed' });
  });
});
