import { describe, it, expect, vi } from 'vitest';
import { createMessageSender } from './message-sender';
import { createAgentInputMessage, AGENT_INPUT_SOURCE } from '@shared/agent-input';
import { SUBMISSION_ERROR as E, QUEUE_PROJECTION as P } from '@shared/agent-submission';

function message() {
  const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.AGENT_VIEW }, content: 'work' });
  if (!built.ok) throw new Error(built.error);
  return built.message;
}

// Submission promises acknowledge queue ownership, never provider completion.
// Changing this contract also requires reviewing IPC, Telegram and D1 callers.
describe('common message sender', () => {
  function setup() {
    let finish!: () => void;
    let written!: () => void;
    const target = { tabId: 'tab' };
    const execute = vi.fn((_target, _message, onWritten) => {
      written = onWritten;
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const sender = createMessageSender({ target: (id: string) => id === 'tab' ? target : undefined, execute, report: vi.fn(), timeoutMs: 10 });
    return { sender, execute, finish: () => finish(), written: () => written() };
  }
  it.each(['queued', 'running'] as const)('returns on %s while execution remains pending, preserving optimistic projection', async state => {
    const s = setup(); const input = message(); const accepted = vi.fn();
    const result = s.sender.submit('tab', input, { onReceived: accepted });
    s.written();
    const items = [{ clientMsgId: input.msgId, state }];
    expect(s.sender.snapshot('tab', items)).toEqual(items);
    await expect(result).resolves.toEqual({ ok: true });
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.execute).toHaveBeenCalledOnce();
    s.finish();
  });
  it('filters mirrored sends only in their target View and confirms once', async () => {
    const s = setup(); const input = message(); const accepted = vi.fn();
    const result = s.sender.submit('tab', input, { projection: P.MIRRORED, onReceived: accepted });
    const items = [{ clientMsgId: input.msgId, state: 'queued' as const }];
    expect(s.sender.snapshot('other', items)).toEqual(items);
    expect(s.sender.snapshot('tab', items)).toEqual([]);
    s.sender.snapshot('tab', items);
    await expect(result).resolves.toEqual({ ok: true });
    expect(accepted).toHaveBeenCalledOnce(); s.finish();
  });
  it('reports typed validation and target failures without executing', async () => {
    const s = setup();
    await expect(s.sender.submit('tab', {} as any)).resolves.toMatchObject({ ok: false, error: { code: E.INVALID } });
    await expect(s.sender.submit('missing', message())).resolves.toMatchObject({ ok: false, error: { code: E.TARGET_MISSING } });
    expect(s.execute).not.toHaveBeenCalled();
  });
  it('reports timeout without cancellation and reconciles a late receipt independently', async () => {
    vi.useFakeTimers();
    try {
      const s = setup(); const input = message(); const accepted = vi.fn();
      const result = s.sender.submit('tab', input, { onReceived: accepted }); s.written();
      await vi.advanceTimersByTimeAsync(11);
      await expect(result).resolves.toMatchObject({ ok: false, error: { code: E.TIMEOUT } });
      s.sender.snapshot('tab', [{ clientMsgId: input.msgId, state: 'running' }]);
      expect(accepted).toHaveBeenCalledOnce();
      await expect(result).resolves.toMatchObject({ ok: false, error: { code: E.TIMEOUT } });
      s.finish();
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])('distinguishes execution ending before receipt with written=%s', async written => {
    const s = setup(); const result = s.sender.submit('tab', message());
    if (written) s.written(); s.finish();
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: written ? E.UNCONFIRMED : E.NOT_SENT } });
  });
  it('rejects duplicate active IDs and clears only the closed View', async () => {
    const s = setup(); const input = message();
    const result = s.sender.submit('tab', input);
    await expect(s.sender.submit('tab', input)).resolves.toMatchObject({ ok: false, error: { code: E.DUPLICATE } });
    s.sender.close('other');
    s.sender.close('tab');
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: E.NOT_SENT } });
    s.finish();
  });
  it('drains rejected executions and reports callback failures without losing confirmation', async () => {
    const report = vi.fn();
    const sender = createMessageSender({ target: () => ({}), execute: async () => { throw new Error('initialization failed'); }, report });
    await expect(sender.submit('tab', message())).resolves.toMatchObject({ ok: false, error: { code: E.NOT_SENT } });
    expect(report).toHaveBeenCalledWith(expect.stringContaining('tabId=tab'), expect.objectContaining({ message: 'initialization failed' }));
    const s = setup(); const input = message();
    const result = s.sender.submit('tab', input, { onReceived: () => { throw new Error('caller failed'); } });
    s.sender.snapshot('tab', [{ clientMsgId: input.msgId, state: 'running' }]);
    await expect(result).resolves.toEqual({ ok: true }); s.finish();
  });
  it('does not let an old reader cleanup remove a reopened View submission', async () => {
    const s = setup(); const input = message();
    let finishOld!: () => void;
    s.execute.mockImplementationOnce(() => new Promise<void>(resolve => { finishOld = resolve; }));
    const old = s.sender.submit('tab', input);
    s.sender.close('tab'); await expect(old).resolves.toMatchObject({ ok: false });
    const next = s.sender.submit('tab', input);
    finishOld(); await Promise.resolve(); await Promise.resolve();
    s.sender.snapshot('tab', [{ clientMsgId: input.msgId, state: 'running' }]);
    await expect(next).resolves.toEqual({ ok: true }); s.finish();
  });
});
