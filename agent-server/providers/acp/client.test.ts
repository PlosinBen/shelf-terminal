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

  it('namespaces messageId-less replies per turn so they do not collide (copilot --acp case)', async () => {
    // copilot --acp omits `messageId` on agent_message_chunk → translate falls back
    // to the DEFAULT_AGENT_MSG_ID constant. Without per-turn namespacing, every
    // turn's reply reuses that id and the renderer upserts them onto one entry.
    const mock = createMockAcpAgent({
      updatesOnPrompt: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as SessionUpdate],
    });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });

    const w1: OutgoingMessage[] = [];
    await driver.drivePromptTurn(conn.agent, session, 'a', (m) => w1.push(m));
    const w2: OutgoingMessage[] = [];
    await driver.drivePromptTurn(conn.agent, session, 'b', (m) => w2.push(m));
    conn.close();

    const reply = (w: OutgoingMessage[]) => w.find((m) => m.type === 'message' && m.msgType === 'reply') as Extract<OutgoingMessage, { msgType: 'reply' }>;
    const stream = (w: OutgoingMessage[]) => w.find((m) => m.type === 'stream') as Extract<OutgoingMessage, { type: 'stream' }>;
    expect(reply(w1).content).toBe('hi');
    expect(reply(w2).content).toBe('hi');
    // Distinct per turn → renderer keeps them as separate bubbles.
    expect(reply(w1).msgId).not.toBe(reply(w2).msgId);
    // A turn's stream chunk and its finalized reply share the turn's id.
    expect(stream(w1).msgId).toBe(reply(w1).msgId);
  });

  it('forwards attached images as ACP image content blocks (drops non-data-urls)', async () => {
    let promptParams: { prompt?: unknown } | undefined;
    const mock = createMockAcpAgent({ onPrompt: (p) => { promptParams = p as typeof promptParams; } });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });
    await driver.drivePromptTurn(conn.agent, session, 'look at this', () => {}, [
      'data:image/png;base64,QUJD',
      'not-a-data-url',
    ]);
    conn.close();
    expect(promptParams?.prompt).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
  });

  it('sends session/set_mode and session/set_config_option', async () => {
    let modeParams: { modeId?: string } | undefined;
    let configParams: { configId?: string; value?: string } | undefined;
    const mock = createMockAcpAgent({
      onSetMode: (p) => { modeParams = p as typeof modeParams; },
      onSetConfigOption: (p) => { configParams = p as typeof configParams; },
    });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });

    await driver.setMode(conn.agent, session, 'mode-x');
    await driver.setConfigOption(conn.agent, session, 'model', 'gpt-5.4');
    conn.close();

    expect(modeParams).toMatchObject({ sessionId: 'mock-session', modeId: 'mode-x' });
    expect(configParams).toMatchObject({ sessionId: 'mock-session', configId: 'model', value: 'gpt-5.4' });
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
