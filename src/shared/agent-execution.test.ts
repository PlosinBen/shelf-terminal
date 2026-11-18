import { describe, expect, it } from 'vitest';
import { EXECUTION_STATE as S, readAgentExecution, reconcileExecution } from './agent-execution';

describe('execution evidence', () => {
  it('does not invent an exit code or infer interruption from 130', () => {
    expect(readAgentExecution(undefined)).toEqual({});
    expect(readAgentExecution({ state: S.FAILED })).toEqual({ execution: { state: S.FAILED } });
    expect(readAgentExecution({ state: S.FAILED, exitCode: 130 })).toEqual({ execution: { state: S.FAILED, exitCode: 130 } });
  });
  it.each([null, {}, { state: 'future' }, { state: S.SUCCEEDED, exitCode: '0' },
    { state: S.RUNNING, exitCode: 0 }, { state: S.SUCCEEDED, exitCode: 1 }, { state: S.FAILED, exitCode: Infinity }])(
    'makes malformed or contradictory metadata unknown: %j', value => {
      expect(readAgentExecution(value)).toMatchObject({ execution: { state: S.UNKNOWN }, anomaly: expect.any(String) });
    });
  it('keeps terminal evidence across partial/late updates and reports contradictory terminal results', () => {
    const failed = { state: S.FAILED, exitCode: 1 };
    expect(reconcileExecution(failed).execution).toEqual(failed);
    expect(reconcileExecution(failed, { state: S.RUNNING }).execution).toEqual(failed);
    expect(reconcileExecution(failed, { state: S.FAILED }).execution).toEqual(failed);
    expect(reconcileExecution(failed, { state: S.SUCCEEDED, exitCode: 0 })).toMatchObject({ execution: failed, anomaly: expect.any(String) });
    expect(reconcileExecution({ state: S.SUCCEEDED }, { state: S.UNKNOWN, exitCode: 130 }).execution).toEqual({ state: S.SUCCEEDED });
  });
  it('lets a final result correct unknown without resurrecting running', () => {
    expect(reconcileExecution({ state: S.UNKNOWN }, { state: S.RUNNING }).execution.state).toBe(S.UNKNOWN);
    expect(reconcileExecution({ state: S.UNKNOWN }, { state: S.SUCCEEDED, exitCode: 0 }).execution).toEqual({ state: S.SUCCEEDED, exitCode: 0 });
  });
});
