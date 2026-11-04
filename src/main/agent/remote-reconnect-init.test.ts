import { EventEmitter } from 'node:events';
import { AGENT_INPUT_SOURCE, createAgentInputMessage } from '@shared/agent-input';
import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

process.env.SHELF_USE_DISPATCHER = '1';
vi.mock('electron', () => ({ app: { getAppPath: () => '/mock/app', getPath: () => '/mock/user-data', isPackaged: false } }));
vi.mock('fs', () => ({ readFileSync: () => '{"version":"1.0.0"}', existsSync: () => true, mkdirSync: vi.fn() }));
vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn() }));
vi.mock('../connector/shell-env', () => ({ getShellEnv: () => ({ PATH: '/usr/bin' }) }));
vi.mock('@shared/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() } }));

it('initializes the replacement exec even when dispatcher keeps the same SessionChannel', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(), stdin: { write: vi.fn(), end: vi.fn() },
  });
  const writes: any[] = [];
  const emit = (frame: object) => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'));
  child.stdin.write.mockImplementation((line: string) => {
    const message = JSON.parse(line);
    writes.push(message);
    queueMicrotask(() => {
      if (message.type === 'open_session') emit({ type: 'ready', sid: message.sid });
      if (message.type === 'get_capabilities') emit({ type: 'capabilities', sid: message.sid, requestId: message.requestId });
      if (message.type === 'send') emit({ type: 'status', state: 'idle', sid: message.sid, executionId: message.executionId });
    });
    return true;
  });
  vi.mocked(spawn).mockReturnValue(child as any);
  const { createRemoteBackend } = await import('./remote');
  let model = 'before';
  const read = vi.fn(() => ({ intent: { model } }));
  const backend = createRemoteBackend({ type: 'local' }, undefined, 'claude', 'session',
    undefined, undefined, undefined, undefined, undefined, undefined, vi.fn(), undefined, undefined,
    { read, onFailure: vi.fn() });
  const drain = async () => {
    const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.AGENT_VIEW }, content: 'hello' });
    if (!built.ok) throw new Error(built.error);
    for await (const _event of backend.query({ inputMessage: built.message }, '/tmp')) { /* drain */ }
  };
  try {
    await drain();
    emit({ type: 'session_down', sid: 'session', reason: 'crashed', willReconnect: true });
    model = 'after';
    emit({ type: 'ready', sid: 'session' });
    await drain();
    expect(writes.filter(m => m.type === 'get_capabilities').map(m => m.intent)).toEqual([{ model: 'before' }, { model: 'after' }]);
    expect(writes.filter(m => m.type === 'send')).toHaveLength(2);
  } finally { backend.dispose(); child.emit('exit', 0); }
});
