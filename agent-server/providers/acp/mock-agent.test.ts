import { describe, it, expect } from 'vitest';
import { client, type SessionUpdate } from '@agentclientprotocol/sdk';
import { createMockAcpAgent } from './mock-agent';
import { translateSessionUpdate } from './translate';
import type { OutgoingMessage } from '../types';

// Runtime smoke test: proves the real ACP SDK drives an in-process agent end-to-end
// (initialize → session/new → prompt → session/update stream → stop) and that the
// pure translate layer maps the streamed updates onto Shelf wire primitives.
describe('mock ACP agent (runtime SDK integration)', () => {
  it('drives a full prompt turn and translates the update stream', async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' }, messageId: 'm1' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' }, messageId: 'm1' },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'completed' },
    ];
    let promptSeen: unknown;
    const mock = createMockAcpAgent({ updatesOnPrompt: updates, onPrompt: (p) => { promptSeen = p; } });

    const wire: OutgoingMessage[] = [];
    const stopReason = await client({ name: 'test-client' }).connectWith(mock, async (ctx) => {
      const session = await ctx.buildSession('/tmp/project').start();
      expect(session.sessionId).toBe('mock-session');
      const done = session.prompt('hi there');
      while (true) {
        const m = await session.nextUpdate();
        if (m.kind === 'stop') return m.stopReason;
        wire.push(...translateSessionUpdate(m.update));
      }
    });

    expect(stopReason).toBe('end_turn');
    expect(promptSeen).toBeTruthy();
    expect(wire).toEqual([
      { type: 'stream', msgId: 'm1', streamType: 'text', content: 'Hello ' },
      { type: 'stream', msgId: 'm1', streamType: 'text', content: 'world' },
      { type: 'message', msgId: 't1', msgType: 'fold_code', label: 'Read', subtitle: 'Read file', body: { content: '' } },
    ]);
  });

  it('advertises the configured auth methods at initialize', async () => {
    const mock = createMockAcpAgent({ authMethods: [{ id: 'chatgpt', name: 'ChatGPT' }] });
    const methods = await client({ name: 'test-client' }).connectWith(mock, async (ctx) => {
      const res = await ctx.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      return res.authMethods;
    });
    expect(methods).toEqual([{ id: 'chatgpt', name: 'ChatGPT' }]);
  });
});
