/** Provider-independent outcomes for a single fold_code operation, not a turn. */
export const EXECUTION_STATE = {
  PENDING: 'pending', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed',
  DECLINED: 'declined', INTERRUPTED: 'interrupted', UNKNOWN: 'unknown',
} as const;
export type ExecutionState = typeof EXECUTION_STATE[keyof typeof EXECUTION_STATE];
export interface AgentExecution { state: ExecutionState; exitCode?: number }
export const EXECUTION_LABEL: Record<ExecutionState, string> = {
  pending: 'Waiting', running: 'Running', succeeded: 'Succeeded', failed: 'Failed',
  declined: 'Not executed: declined', interrupted: 'Interrupted', unknown: 'Result unknown',
};
export function isExecutionPending(execution: AgentExecution): boolean {
  return execution.state === EXECUTION_STATE.RUNNING || execution.state === EXECUTION_STATE.PENDING;
}
export function isExecutionTerminal(execution: AgentExecution): boolean {
  return !isExecutionPending(execution) && execution.state !== EXECUTION_STATE.UNKNOWN;
}
/** Unknown input stays visibly unknown; callers must log the anomaly. */
export function readAgentExecution(value: unknown): { execution?: AgentExecution; anomaly?: string } {
  if (value === undefined) return {};
  const raw = value as Partial<AgentExecution> | null;
  if (!raw || typeof raw !== 'object' || !Object.values(EXECUTION_STATE).includes(raw.state as ExecutionState)
    || (raw.exitCode !== undefined && (!Number.isInteger(raw.exitCode) || raw.exitCode < -2147483648 || raw.exitCode > 2147483647))) {
    return { execution: { state: EXECUTION_STATE.UNKNOWN }, anomaly: 'Invalid execution metadata' };
  }
  const execution: AgentExecution = { state: raw.state!, ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}) };
  if (execution.exitCode !== undefined &&
    (isExecutionPending(execution) || execution.state === EXECUTION_STATE.DECLINED ||
      (execution.state === EXECUTION_STATE.SUCCEEDED && execution.exitCode !== 0))) {
    return { execution: { ...execution, state: EXECUTION_STATE.UNKNOWN }, anomaly: 'Contradictory execution metadata' };
  }
  return { execution };
}

export function reconcileExecution(previous: AgentExecution, incoming?: AgentExecution): { execution: AgentExecution; anomaly?: string } {
  if (!incoming) return { execution: previous };
  if (isExecutionTerminal(previous)) {
    const conflict = isExecutionTerminal(incoming) && (previous.state !== incoming.state ||
      (previous.exitCode !== undefined && incoming.exitCode !== undefined && previous.exitCode !== incoming.exitCode));
    if (conflict) return { execution: previous, anomaly: 'Conflicting terminal execution outcome' };
    return { execution: { ...previous, ...(previous.exitCode === undefined && incoming.state === previous.state && incoming.exitCode !== undefined ? { exitCode: incoming.exitCode } : {}) } };
  }
  if (previous.state === EXECUTION_STATE.UNKNOWN && isExecutionPending(incoming)) return { execution: previous };
  return { execution: incoming };
}
