import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentTab, removeBackgroundTask } from '../../agentTabStore';
import { debugLog } from '../../debugLog';
import type { NormalizedTask } from '../../../shared/types';

// How long to wait for the SDK's terminal task_notification after stopTask
// before force-removing the card (covers a dropped/never-delivered notification
// so a stopping card can't get stuck forever). The id is tombstoned on removal,
// so a late event still can't resurrect it.
const STOP_CONFIRM_TIMEOUT_MS = 5000;
// How long a "Stop?" confirm stays armed before reverting to "Stop" — so a
// stray first click can't leave the button primed to kill on a later click.
const STOP_ARM_REVERT_MS = 3000;
// How long a cleanly-completed task lingers before auto-dismissing itself, so a
// finished card doesn't pile up. Cancelled the moment the user expands the task
// (they're reading it) and never started for a failed/errored task.
const DEFAULT_AUTO_REMOVE_MS = 30000;

// Read lazily (not a module const) so an E2E can shrink the delay via a window
// override at any point before a task settles — driving a real 30s timer in a
// browser test is otherwise impractical. Prod default stays 30s.
function autoRemoveMs(): number {
  const override = (window as { __SHELF_TASK_AUTO_REMOVE_MS__?: number }).__SHELF_TASK_AUTO_REMOVE_MS__;
  return typeof override === 'number' && override > 0 ? override : DEFAULT_AUTO_REMOVE_MS;
}

interface Props {
  tabId: string;
}

// Icons for SETTLED tasks only — a running task renders an animated spinner
// instead (see render) so "alive vs done" is legible at a glance.
const STATUS_ICON: Record<NormalizedTask['status'], string> = {
  pending: '○',
  running: '◐', // unused in render (spinner shown) — kept for completeness
  completed: '✓',
  failed: '✗',
  stopped: '⊘',
};

/**
 * Which trailing affordance a task row shows. Pure so the (done → dismiss) vs
 * (running → two-step Stop) decision is unit-testable without rendering.
 *   - 'stopping'   : stop already requested, awaiting the SDK's terminal event.
 *   - 'dismiss'    : settled task → a plain × that just hides the card (benign).
 *   - 'stop-idle'  : running task → a "Stop" button (first click arms).
 *   - 'stop-armed' : running task, armed → "Stop?" (second click actually kills).
 * Background tasks are real processes; the two-step confirm + distinct danger
 * affordance keep an accidental click from killing live work (unlike the plan
 * panel, which is a read-only checklist with no destructive action).
 */
export type TaskButtonState = 'stopping' | 'dismiss' | 'stop-idle' | 'stop-armed';
export function decideTaskButton(done: boolean, stopping: boolean, armed: boolean): TaskButtonState {
  if (stopping) return 'stopping';
  if (done) return 'dismiss';
  return armed ? 'stop-armed' : 'stop-idle';
}

/**
 * Should a settled task start (or keep) its auto-dismiss countdown? True only
 * for a task that finished cleanly (status 'completed', no error) AND that the
 * user hasn't engaged with (expanded) AND that isn't mid-stop. A failed /
 * stopped / errored task is never auto-removed (the user should see it), and an
 * engaged task is frozen because the user clicked in to read it. Pure so the
 * timing wiring stays unit-testable.
 */
export function shouldAutoRemove(
  task: NormalizedTask,
  engaged: boolean,
  stopping: boolean,
): boolean {
  return task.done && task.status === 'completed' && !task.error && !engaged && !stopping;
}

interface OutputState {
  loading: boolean;
  content?: string;
  error?: string;
}

/**
 * Should we (re)fetch a settled task's output? True when the task is expanded,
 * settled, not mid-fetch, AND we haven't already fetched THIS version of the
 * task object (`lastFetched !== task`).
 *
 * Why identity, not `content === undefined`: a backgrounded shell task settles
 * in TWO steps — a `task_updated` 'done' (no output_file) then, moments-to-
 * minutes later (gated on the SDK auto-resuming at session idle), a
 * `task_notification` that finally carries the output_file. Each lands as a
 * fresh task object via applyTaskEvent. If the user expands in the gap, the
 * first fetch returns the empty "(no output recorded)" placeholder; the OLD
 * gate (`content === undefined`) then cached that forever and never refetched
 * when the file arrived — the empty-card bug. Keying on the task object's
 * identity instead refetches exactly once per new task version (so the
 * file-bearing notification fills the card) without looping on a stable task.
 * See .agent/features/empty-background-task-cards.md.
 */
export function shouldFetchOutput(
  task: NormalizedTask,
  out: OutputState | undefined,
  lastFetched: NormalizedTask | undefined,
): boolean {
  return !!out && task.done && !out.loading && lastFetched !== task;
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
 * confirms it settled (or a fallback timeout fires). A cleanly-completed task
 * (status 'completed', no error) additionally auto-dismisses after
 * AUTO_REMOVE_MS unless the user expands it first (engagement freezes the
 * countdown); a failed/stopped/errored task never auto-removes so the user can
 * see it. Renders nothing when empty. See background-tasks#2 / #4.
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
  // Ids whose Stop button is "armed" (first click) — a second click within
  // STOP_ARM_REVERT_MS actually stops; otherwise it reverts. Guards live work
  // against an accidental single click.
  const [confirmStop, setConfirmStop] = useState<Record<string, true>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const armTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // The task-object version we last issued an output fetch for, per id. Lets the
  // refetch effect tell "already fetched this version" from "a newer task_event
  // arrived" (e.g. the trailing notification that finally carries output_file).
  const lastFetched = useRef<Record<string, NormalizedTask>>({});
  // Pending auto-dismiss timers (cleanly-completed tasks), keyed by id.
  const autoRemoveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Ids the user expanded at least once — engagement permanently cancels the
  // auto-dismiss countdown (they've looked at it; don't yank it away).
  const engaged = useRef<Set<string>>(new Set());

  const disarm = (id: string) => {
    const timer = armTimers.current[id];
    if (timer) { clearTimeout(timer); delete armTimers.current[id]; }
    setConfirmStop((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

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
  useEffect(() => () => {
    for (const id of Object.keys(timers.current)) clearTimeout(timers.current[id]);
    for (const id of Object.keys(armTimers.current)) clearTimeout(armTimers.current[id]);
    for (const id of Object.keys(autoRemoveTimers.current)) clearTimeout(autoRemoveTimers.current[id]);
  }, []);

  // Auto-dismiss a cleanly-completed task after AUTO_REMOVE_MS. Arm a timer once
  // per eligible id; cancel it the moment the task stops being eligible (the user
  // expanded it → `engaged`, or it turned out to be stopping). Engagement is
  // sticky, so collapsing again won't restart the countdown.
  useEffect(() => {
    for (const t of tasks) {
      if (shouldAutoRemove(t, engaged.current.has(t.id), !!stopping[t.id])) {
        if (!autoRemoveTimers.current[t.id]) {
          autoRemoveTimers.current[t.id] = setTimeout(() => {
            delete autoRemoveTimers.current[t.id];
            removeBackgroundTask(tabId, t.id);
          }, autoRemoveMs());
        }
      } else {
        const timer = autoRemoveTimers.current[t.id];
        if (timer) { clearTimeout(timer); delete autoRemoveTimers.current[t.id]; }
      }
    }
    // expandedTasks: engagement is recorded alongside it in toggleExpand, so its
    // change is what re-runs this effect to cancel a just-engaged task's timer.
  }, [tasks, stopping, expandedTasks, tabId]);

  // Fetch a settled task's remote output into its expanded entry. Best-effort —
  // a fetch failure surfaces as the entry's error.
  const loadOutput = useCallback((task: NormalizedTask) => {
    const taskId = task.id;
    // Mark THIS task version as fetched so the refetch effect won't re-issue
    // until a newer task_event replaces the object (e.g. the file-bearing
    // notification). Recorded before the async fetch so a re-render mid-fetch
    // doesn't double-issue.
    lastFetched.current[taskId] = task;
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

  // Fetch (or refetch) a settled, expanded task's output. Covers two cases:
  //   1. expanded WHILE running → fetch once it settles (was the no-fetch branch
  //      in toggleExpand), so the card fills instead of showing "(empty output)".
  //   2. already fetched the empty placeholder in the gap before the output_file
  //      arrived → refetch when the trailing notification replaces the task
  //      object, so a card that first read empty fills in with the real output.
  // shouldFetchOutput keys on task identity, so this fires once per new task
  // version and can't loop on a stable task.
  useEffect(() => {
    for (const t of tasks) {
      if (shouldFetchOutput(t, expandedTasks[t.id], lastFetched.current[t.id])) {
        debugLog('bg-tasks', `refetch id=${t.id.slice(0, 8)} done=${t.done}`);
        loadOutput(t);
      }
    }
  }, [tasks, expandedTasks, loadOutput]);

  // Settled task: × just dismisses (benign). Running task: kill is destructive,
  // so the first click ARMS ("Stop?") and only a second click within
  // STOP_ARM_REVERT_MS actually stops the process.
  const onAction = (task: NormalizedTask) => {
    if (task.done) { removeBackgroundTask(tabId, task.id); return; } // settled — nothing to stop
    if (!confirmStop[task.id]) {
      // Arm: show "Stop?" and auto-revert if not confirmed in time.
      setConfirmStop((prev) => ({ ...prev, [task.id]: true }));
      armTimers.current[task.id] = setTimeout(() => disarm(task.id), STOP_ARM_REVERT_MS);
      return;
    }
    // Confirmed: stop through the SDK, keep the card as "stopping…" until confirmed.
    disarm(task.id);
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
    // The user engaged with this task — permanently cancel its auto-dismiss
    // countdown (the effect below clears any pending timer next render).
    engaged.current.add(task.id);
    // Expanding. A settled task fetches its remote output now; a running task
    // just reveals its full (now wrapping) label/summary — its output is fetched
    // by the effect above once it settles.
    if (task.done) loadOutput(task);
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
                  <span className="agent-task-icon">
                    {t.status === 'running'
                      ? <span className="agent-loading-spinner agent-task-spinner" />
                      : (STATUS_ICON[t.status] ?? '•')}
                  </span>
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
                  {(() => {
                    const btn = decideTaskButton(t.done, !!stopping[t.id], !!confirmStop[t.id]);
                    if (btn === 'stopping') {
                      return <span className="agent-task-stopping" title="Stopping…">stopping…</span>;
                    }
                    if (btn === 'dismiss') {
                      return (
                        <button
                          className="agent-task-dismiss"
                          title="Remove"
                          onClick={(e) => { e.stopPropagation(); onAction(t); }}
                        >
                          &times;
                        </button>
                      );
                    }
                    // Running: a distinct danger "Stop" button (two-step confirm).
                    const armed = btn === 'stop-armed';
                    return (
                      <button
                        className={`agent-task-stop ${armed ? 'armed' : ''}`}
                        title={armed ? 'Click again to stop the running task' : 'Stop the running task'}
                        onClick={(e) => { e.stopPropagation(); onAction(t); }}
                      >
                        {armed ? 'Stop?' : 'Stop'}
                      </button>
                    );
                  })()}
                </div>
                {isExpanded && t.done && (
                  <pre className="agent-task-output">
                    {out.loading ? 'Loading…' : (out.error ? `Error: ${out.error}` : (out.content || '(empty output)'))}
                  </pre>
                )}
                {/* Auto-dismiss countdown: a bar that shrinks over AUTO_REMOVE_MS,
                    purely cosmetic — the JS timer above owns the actual removal.
                    Shown only while the task is auto-remove-eligible, so it
                    vanishes the moment the user engages (expands) the card. The
                    animationDuration is sourced from the same constant so the
                    visual and the timer stay in lockstep. */}
                {shouldAutoRemove(t, engaged.current.has(t.id), !!stopping[t.id]) && (
                  <div className="agent-task-countdown" aria-hidden="true">
                    <span style={{ animationDuration: `${autoRemoveMs()}ms` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
