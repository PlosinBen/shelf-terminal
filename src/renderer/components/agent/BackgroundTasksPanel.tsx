import { useEffect, useRef, useState } from 'react';
import { useAgentTab, removeBackgroundTask } from '../../agentTabStore';
import type { NormalizedTask } from '../../../shared/types';

// How long to wait for the SDK's terminal task_notification after stopTask
// before force-removing the card (covers a dropped/never-delivered notification
// so a stopping card can't get stuck forever). The id is tombstoned on removal,
// so a late event still can't resurrect it.
const STOP_CONFIRM_TIMEOUT_MS = 5000;

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
 * the agent-server — main/renderer never touch the remote fs). A single × per
 * task deletes it: a settled task is just dismissed; a running task is first
 * stopped through the SDK (stopTask) and only leaves the list once the SDK
 * confirms it settled (or a fallback timeout fires). Renders nothing when
 * empty. See DECISIONS #69.
 */
export function BackgroundTasksPanel({ tabId }: Props) {
  const tab = useAgentTab(tabId);
  const tasks = tab?.backgroundTasks ?? [];
  const runningCount = tasks.filter((t) => !t.done).length;
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? runningCount > 0;
  const [openOutputs, setOpenOutputs] = useState<Record<string, OutputState>>({});
  // Ids the user clicked × on while still running — kept visible as "stopping…"
  // until the SDK confirms (task becomes done → auto-removed below) or the
  // fallback timer fires.
  const [stopping, setStopping] = useState<Record<string, true>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const clearStopping = (id: string) => {
    const timer = timers.current[id];
    if (timer) { clearTimeout(timer); delete timers.current[id]; }
    setStopping((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // Once a stopping task settles (SDK delivered its terminal task_notification →
  // t.done), remove it. removeBackgroundTask tombstones the id so the same event
  // can't re-add it.
  useEffect(() => {
    for (const t of tasks) {
      if (stopping[t.id] && t.done) {
        clearStopping(t.id);
        removeBackgroundTask(tabId, t.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, stopping, tabId]);

  // Drop any outstanding timers when the panel unmounts.
  useEffect(() => () => { for (const id of Object.keys(timers.current)) clearTimeout(timers.current[id]); }, []);

  const deleteTask = (task: NormalizedTask) => {
    if (task.done) { removeBackgroundTask(tabId, task.id); return; } // settled — nothing to stop
    // Running: stop through the SDK, keep the card as "stopping…" until confirmed.
    void window.shelfApi.agent.stopTask(tabId, task.id);
    setStopping((prev) => ({ ...prev, [task.id]: true }));
    timers.current[task.id] = setTimeout(() => {
      clearStopping(task.id);
      removeBackgroundTask(tabId, task.id); // SDK never confirmed — force-remove (id is tombstoned)
    }, STOP_CONFIRM_TIMEOUT_MS);
  };

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
                  {stopping[t.id]
                    ? <span className="agent-task-stopping" title="Stopping…">stopping…</span>
                    : (
                      <button
                        className="agent-task-dismiss"
                        title={t.done ? 'Remove' : 'Stop & remove'}
                        onClick={(e) => { e.stopPropagation(); deleteTask(t); }}
                      >
                        &times;
                      </button>
                    )}
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
