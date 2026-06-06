import { useState } from 'react';
import { useAgentTab } from '../../agentTabStore';
import type { NormalizedTask } from '../../../shared/types';

interface Props {
  tabId: string;
}

const STATUS_ICON: Record<NormalizedTask['status'], string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
  stopped: '⊘',
};

/**
 * Sticky "N tasks" indicator + collapsible list of background tasks (a
 * backgrounded Bash, subagent, etc.). Tasks arrive turnId-less via
 * `agent:onBackgroundTasks` → `applyTaskEvent` → `tab.backgroundTasks`.
 * Mirrors Claude Code's "N tasks" affordance. Renders nothing when empty.
 * See .agent/features/background-tasks.md.
 */
export function BackgroundTasksPanel({ tabId }: Props) {
  const tab = useAgentTab(tabId);
  const tasks = tab?.backgroundTasks ?? [];
  // Auto-expand while something is still running; collapse once all settle.
  const runningCount = tasks.filter((t) => !t.done).length;
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? runningCount > 0;

  if (tasks.length === 0) return null;

  const label = runningCount > 0
    ? `${tasks.length} task${tasks.length > 1 ? 's' : ''} · ${runningCount} running`
    : `${tasks.length} task${tasks.length > 1 ? 's' : ''}`;

  return (
    <div className="agent-tasks-panel">
      <div className="agent-tasks-header" onClick={() => setOverride(!expanded)}>
        <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
        <span className="agent-tasks-label">{label}</span>
      </div>
      {expanded && (
        <ul className="agent-tasks-list">
          {tasks.map((t) => (
            <li key={t.id} className={`agent-task-row agent-task-${t.status}`}>
              <span className="agent-task-icon">{STATUS_ICON[t.status] ?? '•'}</span>
              <span className="agent-task-label" title={t.label}>{t.label}</span>
              {t.summary && <span className="agent-task-summary" title={t.summary}>{t.summary}</span>}
              {t.error && <span className="agent-task-error" title={t.error}>{t.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
