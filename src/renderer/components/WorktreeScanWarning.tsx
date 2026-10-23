import { useState } from 'react';
import { useStore } from '../store';
import { emit, Events } from '../events';
export function WorktreeScanWarning({ projectId }: { projectId: string }) {
  const { worktreeScans } = useStore();
  const [open, setOpen] = useState(false);
  const scan = worktreeScans[projectId];
  if (!scan?.error) return null;
  return <span className="worktree-scan-warning" onClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    <button title="Worktree 清單更新失敗，仍保留上次結果" aria-label="Worktree scan failed" onClick={() => setOpen(!open)}>⚠</button>
    {open && <span className="worktree-scan-popover" role="status">
      <span>{scan.error}</span>
      <button disabled={scan.running} onClick={() => emit(Events.WORKTREE_RESCAN, projectId)}>{scan.running ? 'Scanning…' : 'Rescan project worktrees'}</button>
      <button onClick={() => setOpen(false)}>Close</button>
    </span>}
  </span>;
}
