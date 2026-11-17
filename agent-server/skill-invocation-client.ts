import { randomUUID } from 'crypto';
import { SKILL_INVOCATION as I, SKILL_COMMAND_ERROR as E, validSkillValidationResult, SkillCommandFailure, type SkillValidationRequest } from '@shared/skill-invocation';

/** Execution control only: replies are consumed directly from stdin, never queued. */
export function createSkillInvocationClient(
  send: (request: SkillValidationRequest & { type: typeof I.VALIDATE }) => void,
  report: (message: string) => void,
  timeoutMs: number = I.TIMEOUT_MS,
) {
  let epoch = 0;
  const pending = new Map<string, { request: SkillValidationRequest; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    epoch: () => epoch,
    validate(input: Omit<SkillValidationRequest, 'requestId'>, submittedEpoch = epoch): Promise<void> {
      if (submittedEpoch !== epoch) return Promise.reject(new SkillCommandFailure(E.CHANGED, 'Skill invocation was stopped before dispatch'));
      const request = { ...input, requestId: randomUUID() };
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.requestId);
          report(`skill validation timed out requestId=${request.requestId} bindingId=${input.invocation.bindingId} executionId=${input.executionId} msgId=${input.msgId}`);
          reject(new SkillCommandFailure(E.TIMEOUT, 'Skill validation timed out'));
        }, timeoutMs);
        pending.set(request.requestId, { request, resolve, reject, timer });
        try { send({ type: I.VALIDATE, ...request }); }
        catch (error) { clearTimeout(timer); pending.delete(request.requestId); reject(error as Error); }
      });
    },
    receive(raw: unknown): void {
      const value = raw as Record<string, unknown> | null;
      const requestId = typeof value?.requestId === 'string' ? value.requestId : '';
      const entry = pending.get(requestId);
      if (!entry) { report(`unmatched skill validation result requestId=${requestId}`); return; }
      if (value?.executionId !== entry.request.executionId || value.msgId !== entry.request.msgId || value.bindingId !== entry.request.invocation.bindingId || !validSkillValidationResult(value)) {
        report(`malformed skill validation result requestId=${requestId}`);
        pending.delete(requestId); clearTimeout(entry.timer);
        entry.reject(new SkillCommandFailure(E.INVALID, 'Invalid skill validation response'));
        return;
      }
      pending.delete(requestId); clearTimeout(entry.timer);
      if (value.ok) entry.resolve();
      else entry.reject(new SkillCommandFailure(value.code, value.error));
    },
    close(): void {
      epoch++;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new SkillCommandFailure(E.CHANGED, 'Skill validation channel closed')); }
      pending.clear();
    },
  };
}
