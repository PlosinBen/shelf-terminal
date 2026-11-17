import { expect, it, vi } from 'vitest';
import { createSkillInvocationClient } from './skill-invocation-client';
import { SKILL_COMMAND_ERROR as E, SKILL_INVOCATION as I, type SkillValidationRequest } from '@shared/skill-invocation';
const input = { executionId: 'execution', msgId: 'message', invocation: { kind: I.KIND, bindingId: 'binding', skillName: 'flow', registrationId: 'registration', alias: 'dev-flow', args: '', payloadDigest: 'digest' } };
it('registers before send and confirms an immediate correlated control reply', async () => {
  const client = createSkillInvocationClient(request => client.receive({ ...request, bindingId: request.invocation.bindingId, ok: true }), vi.fn());
  await expect(client.validate(input)).resolves.toBeUndefined();
});
it('rejects cross-execution replies and reports late results', async () => {
  let request!: SkillValidationRequest;
  const report = vi.fn();
  const client = createSkillInvocationClient(value => { request = value; }, report);
  const promise = client.validate(input);
  const result = { ...request, bindingId: input.invocation.bindingId, executionId: 'other', ok: true };
  client.receive(result);
  await expect(promise).rejects.toMatchObject({ code: E.INVALID });
  client.receive(result);
  expect(report).toHaveBeenCalledWith(expect.stringContaining('unmatched'));
});
it('times out without retrying and closes pending validation', async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn(); const client = createSkillInvocationClient(send, vi.fn(), 10);
    const first = expect(client.validate(input)).rejects.toMatchObject({ code: E.TIMEOUT });
    await vi.advanceTimersByTimeAsync(11); await first;
    expect(send).toHaveBeenCalledTimes(1);
    const second = expect(client.validate(input)).rejects.toMatchObject({ code: E.CHANGED });
    client.close(); await second;
  } finally { vi.useRealTimers(); }
});

it('does not start validation for an item selected by the queue before a stop', async () => {
  const send = vi.fn(); const client = createSkillInvocationClient(send, vi.fn(), 10);
  const beforeStop = client.epoch();
  client.close();
  const pending = client.validate(input, beforeStop);
  await expect(pending).rejects.toMatchObject({ code: E.CHANGED });
  expect(send).not.toHaveBeenCalled();
});
