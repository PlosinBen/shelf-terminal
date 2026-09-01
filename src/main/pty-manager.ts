import { BrowserWindow, Notification } from 'electron';
import { IPC } from '@shared/ipc-channels';
import {
  PTY_INIT_PRESENTATION_PHASE,
  type Connection,
  type PtyInitPresentationPhase,
} from '@shared/types';
import type { Shell } from './connector/types';
import { createConnector } from './connector';
import { log } from '@shared/logger';
import { maybeScheduleCleanup } from './file-transfer';
import { TargetFactsResolver } from './connector/target-facts';
import { selectTerminalRunner, RUNNER_KIND, type TerminalRunnerSelection } from './terminal-runner/selector';
import { prepareRunnerLaunch, type PreparedRunnerLaunch } from './terminal-runner/runners';
import { TerminalInitSession, TERMINAL_SESSION_PHASE } from './terminal-init-session';
import { createTerminalInitTokens } from '@shared/terminal-init-osc';
import { getAppInstanceId } from './app-instance-id';
import { randomBytes } from 'crypto';

/**
 * Terminal-infra → feature decoupling (architecture-health P1-1).
 *
 * pty-manager owns PTY lifecycle and reports raw signals to an injected
 * observer; feature modules that care about terminal output (pm/ scrollback +
 * tab-watcher) provide the observer, wired by the composition root (index.ts).
 * pty-manager MUST NOT import pm/ — the dependency points feature→infra only,
 * never the reverse. Same injection pattern as pm's setWritePtyFn.
 */
export interface PtyObserver {
  /** Every visible PTY output chunk, before it's forwarded to the renderer. */
  onData?(tabId: string, data: string): void;
  /** A validated external URL frame with its immutable PTY source identity. */
  onExternalUrl?(projectId: string, tabId: string, url: string): void;
  /** A bounded protocol error that never includes the frame payload. */
  onProtocolAnomaly?(projectId: string, tabId: string, anomaly: string): void;
  /** A single tab was killed (killPty). */
  onRemove?(tabId: string): void;
  /** All tabs were killed (killAllPtys). */
  onClear?(): void;
}

let observer: PtyObserver = {};

export function setPtyObserver(o: PtyObserver): void {
  observer = o;
}

const shells = new Map<string, Shell>();
const initSessions = new Map<string, TerminalInitSession>();
const pendingSpawns = new Map<string, AbortController>();
const targetFactsResolver = new TargetFactsResolver();
const projectTabs = new Map<string, Set<string>>();
const tabProjects = new Map<string, string>();
const exitWaiters = new Map<string, Set<() => void>>();

// ── Idle detection for notifications ──
const IDLE_THRESHOLD_MS = 3000;    // 3s no output → idle
const MIN_ACTIVE_MS = 5000;        // must have been active for 5s+ to notify
interface ActivityState {
  firstDataTime: number;
  lastDataTime: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  userInput: boolean;
}
const activity = new Map<string, ActivityState>();
const mutedTabs = new Set<string>();

function clearActivity(tabId: string) {
  const state = activity.get(tabId);
  if (state?.idleTimer) clearTimeout(state.idleTimer);
  activity.delete(tabId);
}

export async function spawnPty(
  projectId: string,
  tabId: string,
  cwd: string,
  connection: Connection,
  win: BrowserWindow,
  initScript?: string,
  tabCmd?: string,
  env?: Record<string, string>,
  requiredEnv?: Record<string, string>,
): Promise<void> {
  const controller = new AbortController();
  pendingSpawns.get(tabId)?.abort();
  pendingSpawns.set(tabId, controller);
  tabProjects.set(tabId, projectId);
  let tabs = projectTabs.get(projectId);
  if (!tabs) {
    tabs = new Set();
    projectTabs.set(projectId, tabs);
  }
  tabs.add(tabId);

  const sendPresentationPhase = (phase: PtyInitPresentationPhase) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.PTY_INIT_PHASE, { tabId, phase });
  };
  sendPresentationPhase(PTY_INIT_PRESENTATION_PHASE.initializing);

  const forwardVisibleData = (data: string) => {
    if (!data) return;
    observer.onData?.(tabId, data);

    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_DATA, { tabId, data });
    }

    const now = Date.now();
    let state = activity.get(tabId);
    if (!state) {
      state = { firstDataTime: now, lastDataTime: now, idleTimer: null, userInput: false };
      activity.set(tabId, state);
    }
    state.lastDataTime = now;

    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      const duration = state!.lastDataTime - state!.firstDataTime;
      if (duration >= MIN_ACTIVE_MS && state!.userInput && !mutedTabs.has(tabId) && !win.isDestroyed() && !win.isFocused()) {
        new Notification({
          title: 'Shelf Terminal',
          body: 'Command finished',
        }).show();
      }
      state!.firstDataTime = Date.now();
      state!.idleTimer = null;
      state!.userInput = false;
    }, IDLE_THRESHOLD_MS);
  };

  try {
    const runtime = createConnector(connection);
    const compatibilityPlan = runtime.createCompatibilityLaunchPlan(cwd, env, requiredEnv);
    const targetFacts = await targetFactsResolver.resolve(runtime, controller.signal, cwd);
    if (controller.signal.aborted) return;
    if (!targetFacts.ok) {
      log.debug(
        'terminal-runtime',
        `target facts unavailable generation=${runtime.generation.id} reason=${targetFacts.reason} attempts=${targetFacts.attempts.map((attempt) => `${attempt.candidate}:${attempt.category}`).join(',')}`,
      );
    }
    const selection = selectTerminalRunner(targetFacts, compatibilityPlan);
    const nonce = randomBytes(18).toString('base64url');
    const runnerContext = {
      runtime,
      selection,
      cwd,
      appId: getAppInstanceId(),
      projectId,
      nonce,
      tokens: createTerminalInitTokens(nonce),
      initScript,
      env,
      requiredEnv,
    };
    const prepared = await prepareRunnerLaunch(runnerContext);
    if (controller.signal.aborted) return;

    let activeShell: Shell | undefined;
    let retriedWithoutIsolation = false;

    const attachShell = (launch: PreparedRunnerLaunch) => {
      const shell = runtime.spawnTerminalPlan(launch.plan);
      activeShell = shell;
      shells.set(tabId, shell);
      const session = new TerminalInitSession({
        shell,
        nonce,
        mode: launch.mode,
        directiveMode: launch.directiveMode,
        initScript,
        tabCmd,
        onVisibleData: forwardVisibleData,
        onExternalUrl: (url) => observer.onExternalUrl?.(projectId, tabId, url),
        onProtocolAnomaly: (anomaly) => {
          const normalized = anomaly === 'external-url:invalid-payload' ? 'invalid-payload' : anomaly;
          observer.onProtocolAnomaly?.(projectId, tabId, normalized);
        },
        onIsolationUnconfirmed: () => {
          log.error('terminal-history', `isolation unconfirmed project=${projectId} tab=${tabId} runner=${selection.kind}`);
        },
        onPhase: (phase) => {
          if (phase === TERMINAL_SESSION_PHASE.runnerInitializing) {
            sendPresentationPhase(PTY_INIT_PRESENTATION_PHASE.initializing);
          } else if (phase === TERMINAL_SESSION_PHASE.initScript) {
            sendPresentationPhase(PTY_INIT_PRESENTATION_PHASE.initScript);
          } else if (phase === TERMINAL_SESSION_PHASE.ready) {
            sendPresentationPhase(PTY_INIT_PRESENTATION_PHASE.ready);
            if (!win.isDestroyed()) win.webContents.send(IPC.PTY_INIT_SENT, { tabId });
          } else if (phase === TERMINAL_SESSION_PHASE.failed) {
            sendPresentationPhase(PTY_INIT_PRESENTATION_PHASE.failed);
          }
        },
        onStartupFailure: (reason) => {
          forwardVisibleData(`\r\n[Terminal startup failed: ${reason}]\r\n`);
        },
      });
      initSessions.set(tabId, session);

      shell.onData((data) => session.handleData(data));
      shell.onExit((exitCode) => {
        if (activeShell !== shell) return;
        const enhancedExitedBeforeReady = launch.historyIsolation === 'attempted'
          && session.currentPhase() === TERMINAL_SESSION_PHASE.runnerInitializing
          && !retriedWithoutIsolation;
        if (enhancedExitedBeforeReady && hasResolvedInterpreter(selection)) {
          retriedWithoutIsolation = true;
          session.dispose();
          log.error(
            'terminal-history',
            `enhanced ${selection.kind} exited before readiness; retrying without isolation project=${projectId} tab=${tabId}`,
          );
          try {
            const cleanPlan = runtime.createInterpreterLaunchPlan(
              cwd, selection.interpreter, ['-l'], env, requiredEnv, [],
            );
            attachShell({
              plan: cleanPlan,
              mode: 'native',
              directiveMode: 'none',
              historyIsolation: 'unconfirmed',
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log.error('pty', `clean retry failed: tabId=${tabId} ${reason}`);
            sendPresentationPhase(PTY_INIT_PRESENTATION_PHASE.failed);
            forwardVisibleData(`\r\n[Terminal startup failed: ${reason}]\r\n`);
            shells.delete(tabId);
            initSessions.delete(tabId);
            removeProjectTab(tabId);
            resolveExitWaiters(tabId);
            if (!win.isDestroyed()) win.webContents.send(IPC.PTY_EXIT, { tabId, exitCode });
          }
          return;
        }

        if (session.currentPhase() === TERMINAL_SESSION_PHASE.runnerInitializing) {
          session.failStartup(`shell exited with code ${exitCode}`);
        }
        session.dispose();
        log.info('pty', `exit: tabId=${tabId} exitCode=${exitCode}`);
        clearActivity(tabId);
        shells.delete(tabId);
        initSessions.delete(tabId);
        removeProjectTab(tabId);
        resolveExitWaiters(tabId);
        if (!win.isDestroyed()) win.webContents.send(IPC.PTY_EXIT, { tabId, exitCode });
      });
      session.start();
    };

    attachShell(prepared);
    maybeScheduleCleanup(projectId, connection, cwd);
  } catch (error) {
    if (controller.signal.aborted) return;
    const reason = error instanceof Error ? error.message : String(error);
    log.error('pty', `startup failed: tabId=${tabId} ${reason}`);
    sendPresentationPhase(PTY_INIT_PRESENTATION_PHASE.failed);
    forwardVisibleData(`\r\n[Terminal startup failed: ${reason}]\r\n`);
    if (!win.isDestroyed()) win.webContents.send(IPC.PTY_EXIT, { tabId, exitCode: 1 });
    removeProjectTab(tabId);
    resolveExitWaiters(tabId);
  } finally {
    if (pendingSpawns.get(tabId) === controller) pendingSpawns.delete(tabId);
  }
}

function hasResolvedInterpreter(
  selection: TerminalRunnerSelection,
): selection is Extract<TerminalRunnerSelection, { interpreter: string }> {
  return 'interpreter' in selection
    && (selection.kind === RUNNER_KIND.zsh || selection.kind === RUNNER_KIND.bash);
}

export function setMuted(tabId: string, muted: boolean) {
  if (muted) {
    mutedTabs.add(tabId);
  } else {
    mutedTabs.delete(tabId);
  }
}

export function writePty(tabId: string, data: string) {
  const state = activity.get(tabId);
  if (state) state.userInput = true;
  initSessions.get(tabId)?.writeUser(data);
}

export function resizePty(tabId: string, cols: number, rows: number) {
  shells.get(tabId)?.resize(cols, rows);
}

export function killPty(tabId: string) {
  const pending = pendingSpawns.get(tabId);
  pending?.abort();
  pendingSpawns.delete(tabId);
  initSessions.get(tabId)?.dispose();
  initSessions.delete(tabId);
  const s = shells.get(tabId);
  if (s) {
    s.kill();
    clearActivity(tabId);
    observer.onRemove?.(tabId);
    shells.delete(tabId);
  } else if (pending) {
    removeProjectTab(tabId);
    resolveExitWaiters(tabId);
  }
}

export async function teardownProjectPtys(
  projectId: string,
  timeoutMs = 3000,
): Promise<{ confirmed: boolean; unconfirmedTabIds: string[] }> {
  const tabIds = [...(projectTabs.get(projectId) ?? [])];
  if (tabIds.length === 0) return { confirmed: true, unconfirmedTabIds: [] };

  const pending = new Set(tabIds);
  const waits = tabIds.map((tabId) => new Promise<void>((resolve) => {
    let waiters = exitWaiters.get(tabId);
    if (!waiters) {
      waiters = new Set();
      exitWaiters.set(tabId, waiters);
    }
    waiters.add(() => {
      pending.delete(tabId);
      resolve();
    });
  }));
  for (const tabId of tabIds) killPty(tabId);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(waits),
    new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timeout) clearTimeout(timeout);
  return { confirmed: pending.size === 0, unconfirmedTabIds: [...pending] };
}

export function killAllPtys() {
  for (const controller of pendingSpawns.values()) controller.abort();
  pendingSpawns.clear();
  for (const session of initSessions.values()) session.dispose();
  initSessions.clear();
  for (const [tabId, s] of shells) {
    clearActivity(tabId);
    s.kill();
    shells.delete(tabId);
  }
  observer.onClear?.();
}

function removeProjectTab(tabId: string): void {
  const projectId = tabProjects.get(tabId);
  if (!projectId) return;
  tabProjects.delete(tabId);
  const tabs = projectTabs.get(projectId);
  tabs?.delete(tabId);
  if (tabs?.size === 0) projectTabs.delete(projectId);
}

function resolveExitWaiters(tabId: string): void {
  const waiters = exitWaiters.get(tabId);
  if (!waiters) return;
  exitWaiters.delete(tabId);
  for (const resolve of waiters) resolve();
}
