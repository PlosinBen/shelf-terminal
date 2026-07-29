import type { AgentEvent } from './types';

const AUDITED_WORKTREE_APP_TOOLS: Record<string, string> = {
  'worktree.propose_create': 'propose_worktree_create',
  'worktree.propose_finish': 'propose_worktree_finish',
};

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function auditBody(input: {
  args: Record<string, unknown>;
  result?: unknown;
}): { content: string } {
  const payload = input.result === undefined
    ? { args: input.args }
    : { args: input.args, result: input.result };
  return { content: stableJson(payload) };
}

export function worktreeAppToolDisplayName(op: string): string | null {
  return AUDITED_WORKTREE_APP_TOOLS[op] ?? null;
}

export function buildWorktreeAppToolAuditEvent(input: {
  requestId: string;
  op: string;
  args: Record<string, unknown>;
  result?: unknown;
}): AgentEvent | null {
  const toolName = worktreeAppToolDisplayName(input.op);
  if (!toolName) return null;

  return {
    type: 'message',
    payload: {
      msgId: `app-tool-${input.requestId}`,
      type: 'fold_code',
      label: 'Shelf tool',
      subtitle: toolName,
      body: auditBody({ args: input.args, result: input.result }),
    },
  };
}
