import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentTab, removeBackgroundTask } from '../../agentTabStore';
import { debugLog } from '../../debugLog';
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
 * A task is expanded but its output was never fetched — true when it was
 * expanded WHILE running (toggleExpand took the no-fetch branch, leaving an
 * entry with no content/error and not loading) and has since settled. Without a
 * follow-up fetch the card would show "(empty output)" forever despite real
 * output existing on disk. `content === undefined` distinguishes "never
 * fetched" from a genuinely empty fetched result (`content === ''`).
 */
export function needsOutputFetch(done: boolean, out: OutputState | undefined): boolean {
  return done && !!out && !out.loading && out.content === undefined && out.error === undefined;
}

/**
 * Sticky "N tasks" indicator + collapsible list of background tasks (a
 * backgrounded Bash, subagent, etc.). Tasks arrive turnId-less via
 * `agent:onBackgroundTasks` → `applyTaskEvent` → `tab.backgroundTasks`.
 * Clicking a task row expands it: the label/summary stop truncating and wrap to
 * show the full text (e.g. a long command), and a settled task additionally
 * fetches its remote output (read on the agent-server — main/renderer never
 * touch the remote fs). A single × per
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
  // Expanded rows (by id). Presence = expanded (label/summary wrap to full text);
  // for a settled task the value also carries its fetched output state.
  const [expandedTasks, setExpandedTasks] = useState<Record<string, OutputState>>({});
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

  // Fetch a settled task's remote output into its expanded entry. Best-effort —
  // a fetch failure surfaces as the entry's error.
  const loadOutput = useCallback((taskId: string) => {
    // Create/replace the entry unconditionally — this is what opens the card for
    // a click on an already-settled task. The .then/.catch keep the `p[taskId]?`
    // guard so a collapse mid-fetch can't resurrect the entry.
    debugLog('bg-tasks', `loadOutput fire id=${taskId.slice(0, 8)}`);
    setExpandedTasks((p) => ({ ...p, [taskId]: { loading: true } }));
    window.shelfApi.agent.fetchTaskOutput(tabId, taskId)
      .then((content) => {
        debugLog('bg-tasks', `loadOutput ok id=${taskId.slice(0, 8)} len=${content?.length ?? 0}`);
        setExpandedTasks((p) => (p[taskId] ? { ...p, [taskId]: { loading: false, content } } : p));
      })
      .catch((err: Error) => {
        debugLog('bg-tasks', `loadOutput err id=${taskId.slice(0, 8)} ${err.message}`);
        setExpandedTasks((p) => (p[taskId] ? { ...p, [taskId]: { loading: false, error: err.message } } : p));
      });
  }, [tabId]);

  // A task expanded WHILE running takes the no-fetch branch in toggleExpand;
  // once it settles, fetch its output here so the card fills in instead of being
  // stuck on "(empty output)". (Tasks expanded after settling already fetched.)
  useEffect(() => {
    for (const t of tasks) {
      if (needsOutputFetch(t.done, expandedTasks[t.id])) {
        debugLog('bg-tasks', `settle-fetch id=${t.id.slice(0, 8)} (expanded-while-running, now done)`);
        loadOutput(t.id);
      }
    }
  }, [tasks, expandedTasks, loadOutput]);

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

  const toggleExpand = (task: NormalizedTask) => {
    if (expandedTasks[task.id]) {
      debugLog('bg-tasks', `toggleExpand collapse id=${task.id.slice(0, 8)}`);
      setExpandedTasks((prev) => { const next = { ...prev }; delete next[task.id]; return next; });
      return;
    }
    debugLog('bg-tasks', `toggleExpand open id=${task.id.slice(0, 8)} done=${task.done}`);
    // Expanding. A settled task fetches its remote output now; a running task
    // just reveals its full (now wrapping) label/summary — its output is fetched
    // by the effect above once it settles.
    if (task.done) loadOutput(task.id);
    else setExpandedTasks((prev) => ({ ...prev, [task.id]: { loading: false } }));
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
            const out = expandedTasks[t.id];
            const isExpanded = !!out;
            return (
              <li key={t.id} className={`agent-task-item agent-task-${t.status}`}>
                <div
                  className={`agent-task-row agent-task-clickable ${isExpanded ? 'agent-task-expanded' : ''}`}
                  onClick={() => toggleExpand(t)}
                >
                  <span className="agent-task-icon">{STATUS_ICON[t.status] ?? '•'}</span>
                  <div className="agent-task-text">
                    {/* Collapsed: just the description (truncated). Expanded:
                        description + summary + error stack vertically, full text.
                        Skip the summary when it just repeats the label (some
                        tasks report their description back as the summary) — a
                        duplicated line is noise. */}
                    <span className="agent-task-label" title={t.label}>{t.label}</span>
                    {isExpanded && t.summary && t.summary.trim() !== t.label.trim() && (
                      <span className="agent-task-summary">{t.summary}</span>
                    )}
                    {isExpanded && t.error && <span className="agent-task-error">{t.error}</span>}
                  </div>
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
                {isExpanded && t.done && (
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
