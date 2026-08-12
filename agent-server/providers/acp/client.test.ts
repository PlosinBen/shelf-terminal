import { describe, it, expect } from 'vitest';
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import { createMockAcpAgent } from './mock-agent';
import { openAcpConnection } from './connection';
import { createSessionDriver } from './client';
import type { OutgoingMessage } from '../types';

// Exercises the toolkit runtime path end-to-end (connection + driver + turn)
// against the in-process mock agent — no stdio, no binary, no credentials.
describe('acp session driver (connection + new/resume + turn)', () => {
  it('drives a prompt: forwards stream deltas and a tool card without manufacturing a full reply', async () => {
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
      { type: 'message', msgId: 't1', msgType: 'fold_code', label: 'Read', subtitle: 'Read', body: { content: '' } },
    ]);
  });

  it('promotes a task_complete-only turn to a markdown reply even when completion settles after the prompt response', async () => {
    const driver = createSessionDriver();
    const lateSummary: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'task-complete-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'final summary' } }],
    };
    const mock = createMockAcpAgent({
      updatesOnPrompt: [{
        sessionUpdate: 'tool_call',
        toolCallId: 'task-complete-1',
        title: 'task_complete',
        kind: 'other',
        status: 'in_progress',
      }],
      onPrompt: () => {
        // The ACP SDK processes notifications independently from the matching
        // prompt response. Reproduce the production race beyond the old one-tick
        // barrier: the response resolves, then the result-bearing partial update
        // reaches our callback two event-loop turns later.
        setImmediate(() => setImmediate(() => driver.onSessionUpdate({
          sessionId: 'mock-session', update: lateSummary,
        })));
      },
    });
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/proj' });
    const wire: OutgoingMessage[] = [];

    try {
      await driver.drivePromptTurn(conn.agent, session, 'hi', (m) => wire.push(m));
      // Prompt settlement controls idle/queue release; content delivery remains
      // live. The terminal callback intentionally has not run yet.
      expect(wire).not.toContainEqual(expect.objectContaining({ msgId: 'task-complete-1' }));
      await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
      expect(wire).toContainEqual({
        type: 'message',
        msgId: 'task-complete-1',
        msgType: 'reply',
        content: 'final summary',
      });
    } finally {
      conn.close();
    }
  });

  it('renders task_complete as a normal reply when the same turn already emitted assistant text', async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      { sessionUpdate: 'tool_call', toolCallId: 'task-complete-2', title: 'task_complete', kind: 'other', status: 'in_progress' },
      {
        sessionUpdate: 'tool_call_update', toolCallId: 'task-complete-2', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'completion summary' } }],
      },
    ] as SessionUpdate[];
    const mock = createMockAcpAgent({ updatesOnPrompt: updates });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });
    const wire: OutgoingMessage[] = [];

    await driver.drivePromptTurn(conn.agent, session, 'go', (m) => wire.push(m));
    conn.close();

    expect(wire).toContainEqual(expect.objectContaining({ type: 'stream', streamType: 'text', content: 'answer' }));
    expect(wire).toContainEqual({
      type: 'message', msgId: 'task-complete-2', msgType: 'reply', content: 'completion summary',
    });
  });

  it('attributes a late task_complete to the turn where its tool call started', async () => {
    const mock = createMockAcpAgent();
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });
    const firstWire: OutgoingMessage[] = [];
    await driver.drivePromptTurn(conn.agent, session, 'first', (m) => firstWire.push(m));
    driver.onSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'late-task-complete', title: 'task_complete',
        kind: 'other', status: 'in_progress',
      },
    });

    const secondWire: OutgoingMessage[] = [];
    await driver.drivePromptTurn(conn.agent, session, 'second', (m) => secondWire.push(m));
    driver.onSessionUpdate({
      sessionId: session.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second answer' } } as SessionUpdate,
    });
    driver.onSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'late-task-complete', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'first summary' } }],
      },
    });
    conn.close();

    expect(secondWire).toContainEqual({
      type: 'message', msgId: 'late-task-complete', msgType: 'reply', content: 'first summary',
    });
  });

  it('namespaces messageId-less replies per prompt so they do not collide (copilot --acp case)', async () => {
    // copilot --acp omits `messageId` on agent_message_chunk → translate falls back
    // to the DEFAULT_AGENT_MSG_ID constant. Without per-prompt namespacing, every
    // prompt's reply reuses that id and the renderer upserts them onto one entry.
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

    const stream = (w: OutgoingMessage[]) => w.find((m) => m.type === 'stream') as Extract<OutgoingMessage, { type: 'stream' }>;
    expect(stream(w1).content).toBe('hi');
    expect(stream(w2).content).toBe('hi');
    // Distinct per prompt → renderer keeps them as separate bubbles.
    expect(stream(w1).msgId).not.toBe(stream(w2).msgId);
  });

  it('strips only a thought message prefix, preserving a later paragraph chunk (codex)', async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '\n  \n' }, messageId: 'thought-1' },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Inspecting the runtime**' }, messageId: 'thought-1' },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '\n\n**Verifying the result**' }, messageId: 'thought-1' },
    ];
    const mock = createMockAcpAgent({ updatesOnPrompt: updates });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });
    const wire: OutgoingMessage[] = [];
    await driver.drivePromptTurn(conn.agent, session, 'go', (m) => wire.push(m));
    conn.close();

    expect(wire.filter((m) => m.type === 'stream')).toEqual([
      { type: 'stream', msgId: 'thought-1', streamType: 'thinking', content: '**Inspecting the runtime**' },
      { type: 'stream', msgId: 'thought-1', streamType: 'thinking', content: '\n\n**Verifying the result**' },
    ]);
  });

  it('splits messageId-less text at TOOL boundaries → separate reply cards (copilot interleaving)', async () => {
    // text → tool → text with no messageId: mirrors Zed (text after a tool is a
    // NEW message). Without segmenting, both texts collapse onto one early card.
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } } as SessionUpdate,
      { sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'Do', kind: 'execute', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } } as SessionUpdate,
    ];
    const mock = createMockAcpAgent({ updatesOnPrompt: updates });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });
    const wire: OutgoingMessage[] = [];
    await driver.drivePromptTurn(conn.agent, session, 'go', (m) => wire.push(m));
    conn.close();

    const textStreams = wire.filter((m): m is Extract<OutgoingMessage, { type: 'stream' }> =>
      m.type === 'stream' && m.streamType === 'text');
    expect(textStreams.map((m) => m.content)).toEqual(['before', 'after']);
    // Distinct ids → two cards at their own positions (closing text not merged up top).
    expect(textStreams[0].msgId).not.toBe(textStreams[1].msgId);
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

  it('captures available_commands_update per session', () => {
    const driver = createSessionDriver();
    expect(driver.getAvailableCommands('s1')).toBeUndefined();
    driver.onSessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'x' }] },
    } as Parameters<typeof driver.onSessionUpdate>[0]);
    expect(driver.getAvailableCommands('s1')).toEqual([{ name: 'compact', description: 'x' }]);
    driver.forget('s1');
    expect(driver.getAvailableCommands('s1')).toBeUndefined();
  });

  it('clears carried tool metadata when a session is forgotten', async () => {
    const driver = createSessionDriver();
    const mock = createMockAcpAgent();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const first = await driver.startNew(conn.agent, { cwd: '/tmp/p' });
    await driver.drivePromptTurn(conn.agent, first, 'first', () => {});
    driver.onSessionUpdate({
      sessionId: first.sessionId,
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'reused', title: 'task_complete',
        kind: 'other', status: 'in_progress',
      },
    });

    driver.forget(first.sessionId);
    const resumed = await driver.resume(conn.agent, first.sessionId, { cwd: '/tmp/p' });
    const wire: OutgoingMessage[] = [];
    await driver.drivePromptTurn(conn.agent, resumed, 'second', (m) => wire.push(m));
    driver.onSessionUpdate({
      sessionId: resumed.sessionId,
      update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'reused', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'not a summary without its title' } }],
      },
    });
    conn.close();

    expect(wire).not.toContainEqual(expect.objectContaining({ msgId: 'reused', msgType: 'reply' }));
    expect(wire).toContainEqual({
      type: 'message', msgId: 'reused', msgType: 'fold_code', label: 'Tool',
      body: { content: 'not a summary without its title' },
    });
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

  it('publishes authoritative mode and config replacement snapshots from ACP', async () => {
    const initialConfig: SessionConfigOption[] = [{
      type: 'select',
      id: 'allow_all',
      name: 'Allow all',
      category: 'permissions',
      currentValue: 'on',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    }];
    const changes: unknown[] = [];
    const driver = createSessionDriver({ onStateChange: (sessionId, change) => changes.push({ sessionId, change }) });
    const mock = createMockAcpAgent({ configOptions: initialConfig });
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });

    await driver.setConfigOption(conn.agent, session, 'allow_all', 'on');
    driver.onSessionUpdate({
      sessionId: session.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'autopilot' },
    });
    const replacementConfig: SessionConfigOption[] = initialConfig.map((option) => (
      option.type === 'select' ? { ...option, currentValue: 'off' } : option
    ));
    driver.onSessionUpdate({
      sessionId: session.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: replacementConfig },
    });
    conn.close();

    expect(changes).toEqual([
      {
        sessionId: 'mock-session',
        change: { kind: 'config_options', configOptions: initialConfig },
      },
      {
        sessionId: 'mock-session',
        change: { kind: 'mode', currentModeId: 'autopilot' },
      },
      {
        sessionId: 'mock-session',
        change: { kind: 'config_options', configOptions: replacementConfig },
      },
    ]);
  });

  it('passes additionalDirectories + mcpServers to session/new', async () => {
    let newParams: { additionalDirectories?: string[]; mcpServers?: unknown } | undefined;
    const mock = createMockAcpAgent({ onNewSession: (p) => { newParams = p as typeof newParams; } });
    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, { onSessionUpdate: driver.onSessionUpdate });
    const session = await driver.startNew(conn.agent, {
      cwd: '/tmp/p',
      additionalDirectories: ['/tmp/p/codex'],
      mcpServers: [{ name: 'fs', command: 'x', args: [], env: [] }],
    });
    expect(session.sessionId).toBe('mock-session');
    expect(newParams?.additionalDirectories).toEqual(['/tmp/p/codex']);
    expect(newParams?.mcpServers).toEqual([{ name: 'fs', command: 'x', args: [], env: [] }]);
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
    expect(wire).toContainEqual({ type: 'stream', msgId: 'r1', streamType: 'text', content: 'resumed' });
  });
});
