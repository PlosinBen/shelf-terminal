import { useState } from 'react';
import { useAgentTab, removeBackgroundTask } from '../../agentTabStore';
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

interface OutputState {
  loading: boolean;
  content?: string;
  error?: string;
}

/**
 * Sticky "N tasks" indicator + collapsible list of background tasks (a
 * backgrounded Bash, subagent, etc.). Tasks arrive turnId-less via
 * `agent:onBackgroundTasks` → `applyTaskEvent` → `tab.backgroundTasks`.
 * Completed tasks can be clicked to fetch their full remote output (read on
 * the agent-server — main/renderer never touch the remote fs) and dismissed
 * with ×. Renders nothing when empty. See DECISIONS #69.
 */
export function BackgroundTasksPanel({ tabId }: Props) {
  const tab = useAgentTab(tabId);
  const tasks = tab?.backgroundTasks ?? [];
  const runningCount = tasks.filter((t) => !t.done).length;
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? runningCount > 0;
  const [openOutputs, setOpenOutputs] = useState<Record<string, OutputState>>({});

  if (tasks.length === 0) return null;

  const label = runningCount > 0
    ? `${tasks.length} task${tasks.length > 1 ? 's' : ''} · ${runningCount} running`
    : `${tasks.length} task${tasks.length > 1 ? 's' : ''}`;

  const toggleOutput = (task: NormalizedTask) => {
    if (!task.done) return; // output only exists once the task settled
    setOpenOutputs((prev) => {
      if (prev[task.id]) {
        const next = { ...prev };
        delete next[task.id];
        return next;
      }
      // Open + kick off the fetch.
      void window.shelfApi.agent.fetchTaskOutput(tabId, task.id)
        .then((content) => setOpenOutputs((p) => (p[task.id] ? { ...p, [task.id]: { loading: false, content } } : p)))
        .catch((err: Error) => setOpenOutputs((p) => (p[task.id] ? { ...p, [task.id]: { loading: false, error: err.message } } : p)));
      return { ...prev, [task.id]: { loading: true } };
    });
  };

  return (
    <div className="agent-tasks-panel">
      <div className="agent-tasks-header" onClick={() => setOverride(!expanded)}>
        <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
        <span className="agent-tasks-label">{label}</span>
      </div>
      {expanded && (
        <ul className="agent-tasks-list">
          {tasks.map((t) => {
            const out = openOutputs[t.id];
            return (
              <li key={t.id} className={`agent-task-item agent-task-${t.status}`}>
                <div className={`agent-task-row ${t.done ? 'agent-task-clickable' : ''}`} onClick={() => toggleOutput(t)}>
                  <span className="agent-task-icon">{STATUS_ICON[t.status] ?? '•'}</span>
                  <span className="agent-task-label" title={t.label}>{t.label}</span>
                  {t.summary && <span className="agent-task-summary" title={t.summary}>{t.summary}</span>}
                  {t.error && <span className="agent-task-error" title={t.error}>{t.error}</span>}
                  <button
                    className="agent-task-dismiss"
                    title="Dismiss"
                    onClick={(e) => { e.stopPropagation(); removeBackgroundTask(tabId, t.id); }}
                  >
                    &times;
                  </button>
                </div>
                {out && (
                  <pre className="agent-task-output">
                    {out.loading ? 'Loading…' : (out.error ? `Error: ${out.error}` : (out.content || '(empty output)'))}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
