import { describe, it, expect } from 'vitest';
import type { PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { createMockAcpAgent } from './mock-agent';
import { openAcpConnection } from './connection';
import { createSessionDriver } from './client';
import { createPermissionBridge, pickOptionId } from './permission';
import type { OutgoingMessage, SendFn } from '../types';

const OPTIONS: PermissionOption[] = [
  { optionId: 'ao', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'ro', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'ra', name: 'Always reject', kind: 'reject_always' },
];

describe('pickOptionId', () => {
  it('maps allow/deny × once/session to the matching ACP option kind', () => {
    expect(pickOptionId(OPTIONS, true, 'once')).toBe('ao');
    expect(pickOptionId(OPTIONS, true, 'session')).toBe('aa');
    expect(pickOptionId(OPTIONS, false, 'once')).toBe('ro');
    expect(pickOptionId(OPTIONS, false, 'session')).toBe('ra');
  });

  it('falls back to any allow/reject option when the exact kind is absent', () => {
    const only = [{ optionId: 'x', name: 'ok', kind: 'allow_always' as const }];
    expect(pickOptionId(only, true, 'once')).toBe('x');
    expect(pickOptionId(only, false, 'once')).toBeUndefined();
  });
});

describe('permission round-trip (mock agent asks → wire → resolve → agent)', () => {
  it('bridges request_permission to the wire and resolves the selected option', async () => {
    let outcome: RequestPermissionResponse['outcome'] | undefined;
    const mock = createMockAcpAgent({
      requestPermissionOnPrompt: { toolCallId: 'tc1', title: 'Write file', options: OPTIONS },
      onPermissionOutcome: (o) => { outcome = o; },
      updatesOnPrompt: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' }, messageId: 'm1' }],
    });

    const wire: OutgoingMessage[] = [];
    let currentSend: SendFn | null = null;
    const bridge = createPermissionBridge(() => currentSend);
    // Auto-answer: allow-once as soon as the permission request hits the wire.
    currentSend = (m) => {
      wire.push(m);
      if (m.type === 'permission_request') bridge.resolvePermission(m.toolUseId, true, undefined, 'once');
    };

    const driver = createSessionDriver();
    const conn = openAcpConnection(mock, {
      onRequestPermission: bridge.onRequestPermission,
      onSessionUpdate: driver.onSessionUpdate,
    });
    const session = await driver.startNew(conn.agent, { cwd: '/tmp/p' });
    await driver.drivePromptTurn(conn.agent, session, 'edit please', currentSend);
    conn.close();

    expect(outcome).toEqual({ outcome: 'selected', optionId: 'ao' });
    expect(wire.find((m) => m.type === 'permission_request')).toMatchObject({
      type: 'permission_request', toolUseId: 'tc1', toolName: 'Write file',
    });
  });
});
