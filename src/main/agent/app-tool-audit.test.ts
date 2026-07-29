import { describe, expect, it } from 'vitest';
import { buildWorktreeAppToolAuditEvent, worktreeAppToolDisplayName } from './app-tool-audit';

describe('worktree app-tool audit events', () => {
  it('maps only worktree app-tool ops to Shelf MCP tool names', () => {
    expect(worktreeAppToolDisplayName('worktree.propose_create')).toBe('propose_worktree_create');
    expect(worktreeAppToolDisplayName('worktree.propose_finish')).toBe('propose_worktree_finish');
    expect(worktreeAppToolDisplayName('web.fetch')).toBeNull();
  });

  it('builds a fold_code card with raw args and completed result', () => {
    const pending = buildWorktreeAppToolAuditEvent({
      requestId: 'r1',
      op: 'worktree.propose_create',
      args: { branch: 'feature/x', note: '.agent/features/x.md' },
    });
    expect(pending).toMatchObject({
      type: 'message',
      payload: {
        msgId: 'app-tool-r1',
        type: 'fold_code',
        label: 'Shelf tool',
        subtitle: 'propose_worktree_create',
      },
    });
    expect((pending as any).payload.body.content).toContain('"note": ".agent/features/x.md"');

    const completed = buildWorktreeAppToolAuditEvent({
      requestId: 'r1',
      op: 'worktree.propose_create',
      args: { branch: 'feature/x', note: '.agent/features/x.md' },
      result: { ok: true, data: { notePaths: ['.agent/features/x.md'] } },
    });
    expect((completed as any).payload.body.content).toContain('"notePaths": [');
  });
});
