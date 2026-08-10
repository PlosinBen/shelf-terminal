import { useSyncExternalStore } from 'react';
import type { AgentMsg } from './components/AgentMessage';
import type { AgentFile, AgentInitPhase, AgentLoginPrompt, AgentLoginResult, AgentPrefs, AgentProvider, AgentQueueItem, AuthMethod, NormalizedTask, TaskEvent } from '../shared/types';
import { loadAgentMessagesLatest, saveAgentMessagesDelta, clearAgentSession } from './storage/agent-history';
import { reconcileQueueSnapshot, type PendingSend } from './queue-reconcile';
import { debugLog } from './debugLog';
import { formatTabLogId } from '../shared/tab-id';

// Per-tab store for agent UI state. Split from store.ts because the
// global store rebuilds its snapshot on every change — every useStore
// consumer re-renders. Agent state changes (stream chunks, status
// pings) fire dozens of times per execution; bundling them with project /
// settings would force every component to re-render. This store
// notifies only the listeners registered for the tab that changed.
//
// Lifecycle: AgentView calls initTab on mount; actual agent-tab teardown owns
// removeTab. Backend events route here via the typed bus
// (events/ipc-agent.ts → store subscriptions installed by App.tsx).

// ── Types ──

export type StatusSegment = { text: string; severity?: 'normal' | 'warning' | 'critical' };

export interface CycleOption {
  value: string;
  displayName: string;
  severity?: 'normal' | 'info' | 'warning' | 'critical';
}

export interface Capabilities {
  models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[];
  permissionModes: CycleOption[];
  effortLevels: CycleOption[];
  slashCommands: { name: string; description: string }[];
  authMethod?: AuthMethod;
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode?: string;
  /** True when the provider's tab-open auth probe found no valid credentials. */
  authRequired?: boolean;
}

export interface PendingPermission {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PendingPicker {
  id: string;
  prompts: Array<{
    question: string;
    header?: string;
    multiSelect: boolean;
    options: Array<{ label: string; description?: string; preview?: string }>;
    inputType?: 'text' | 'number' | 'integer';
    currentValue?: string | string[];
  }>;
}

export interface LocalPicker {
  key: 'model' | 'effort' | 'permissionMode';
}

export interface AgentTabState {
  // identity
  sessionId: string;
  provider: AgentProvider;

  // domain
  messages: AgentMsg[];
  // Server-owned send queue (display mirror). The renderer eager-sends every
  // submission and optimistically tracks it here as a chip; agent-server emits
  // the authoritative queue snapshot and reconcileQueueSnapshot folds it in,
  // promoting items into the timeline when their execution starts. `promotedClientMsgIds`
  // dedups promotion. See queue-reconcile.ts + message-queue-ownership design.
  pendingSends: PendingSend[];
  promotedClientMsgIds: Set<string>;
  currentPlan: string;
  // Background tasks (executionId-less side-channel). Upserted by id from task_event;
  // ordered by first-seen. See background-tasks#2.
  backgroundTasks: NormalizedTask[];
  // Ids the user deleted — tombstoned so a later task_notification (e.g. the
  // 'stopped' echo after stopTask, or a execution-boundary snapshot) can't resurrect
  // a card the user already dismissed. Cleared on /clear.
  dismissedTaskIds: Set<string>;

  // status (display only — what backend reports)
  isExecutionActive: boolean;
  actualModel: string | null;
  actualEffort: string;
  actualPermissionMode: string;
  costUsd: number | undefined;
  numTurns: number | undefined;
  contextUsage: StatusSegment | null;
  rateLimits: StatusSegment[];
  /** Account-level usage (copilot premium-request quota). Shared per host/account. */
  credits: StatusSegment | null;

  // capabilities
  capabilities: Capabilities | null;

  // decisions
  pendingPermission: PendingPermission | null;
  pendingPicker: PendingPicker | null;
  localPicker: LocalPicker | null;

  // auth
  authRequired: { provider: string } | null;
  authBusy: boolean;
  authError: string | null;
  // Interactive device-flow login (Copilot). `loginPrompt` holds the
  // verification URL + code while login is in progress; `loginBusy` gates the
  // button (true from click until auth_login_done). See features copilot-device-login.
  loginPrompt: AgentLoginPrompt | null;
  loginBusy: boolean;

  // init
  initStatus: 'starting' | 'ready' | 'failed';
  // Sub-phase shown only while initStatus==='starting' (display-only; the
  // tri-state initStatus stays the control signal). Null = generic spinner text.
  initPhase: AgentInitPhase | null;
  initError: string | null;
}

// ── Module-scoped state ──

type Listener = () => void;
const tabs = new Map<string, AgentTabState>();
const listeners = new Map<string, Set<Listener>>();
// Per-init identity token for async history hydration. Clear/remove invalidates
// any IndexedDB read that started earlier so its stale snapshot cannot merge
// back into a newly-cleared or recreated tab. See agent-ui#10.
const historyLoadTokens = new Map<string, symbol>();

// Settings synced from App.tsx. inMemoryMax used to be clamped against
// an idbMax sibling; that was removed when IDB went unlimited via the
// dirty-snapshot save refactor. in-memory still has a cap for RAM /
// React reconciliation reasons.
const DEFAULT_THROTTLE_MS = 5000;
const DEFAULT_IN_MEMORY_MAX = 500;
let saveThrottleMs = DEFAULT_THROTTLE_MS;
let inMemoryMax = DEFAULT_IN_MEMORY_MAX;

export function setInMemoryMax(n: number) {
  inMemoryMax = Math.max(1, n);
}
export function setSaveThrottleMs(ms: number) {
  saveThrottleMs = Math.max(0, ms);
}

// ── Listener bookkeeping ──

function notify(tabId: string) {
  const set = listeners.get(tabId);
  if (!set) return;
  set.forEach((l) => l());
}

function subscribe(tabId: string, listener: Listener): () => void {
  let set = listeners.get(tabId);
  if (!set) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(tabId);
  };
}

function getSnapshot(tabId: string): AgentTabState | undefined {
  return tabs.get(tabId);
}

/**
 * Non-reactive read for cross-module callers that need to peek at a
 * tab's current state outside of React (e.g. IPC subscription handlers
 * inspecting `pendingPicker` to decide whether to cancel before
 * replacing). Treat the result as a snapshot — never mutate.
 */
export function peekAgentTab(tabId: string): AgentTabState | undefined {
  return tabs.get(tabId);
}

// ── React hook ──

export function useAgentTab(tabId: string): AgentTabState | undefined {
  return useSyncExternalStore(
    (l) => subscribe(tabId, l),
    () => getSnapshot(tabId),
  );
}

// ── Save throttle infrastructure ──
//
// Delta-save model: we batch dirty msg snapshots inside a throttle
// window and append them to IDB at flush time. Why snapshot at mark
// time (Map<id, AgentMsg>) instead of filter-at-save against
// tab.messages: the latter races with trimMessagesInMemory — a msg
// marked dirty mid-window can be evicted from tab.messages before
// doSave runs, then the filter misses it and we lose the write.
// Snapshotting decouples the two paths: trim only affects in-memory
// view, dirty queue is its own buffer.
//
// `deletedIds` is forward-compat (no caller populates it yet — only
// whole-session clear exists). Implementation supports it so the
// PendingSave shape matches future single-message deletion.

interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  dirtyMsgs: Map<string, AgentMsg>;
  deletedIds: Set<string>;
}
const pendingSaves = new Map<string, PendingSave>();

function ensurePendingSave(tabId: string): PendingSave {
  const existing = pendingSaves.get(tabId);
  if (existing) return existing;
  const entry: PendingSave = {
    dirtyMsgs: new Map(),
    deletedIds: new Set(),
    timer: setTimeout(() => doSaveCallback(tabId), saveThrottleMs),
  };
  pendingSaves.set(tabId, entry);
  return entry;
}

function markDirty(tabId: string, msg: AgentMsg) {
  const entry = ensurePendingSave(tabId);
  // Later mark within the same window wins — Map.set overwrites the
  // snapshot, which is correct (latest state is what we want to persist).
  entry.dirtyMsgs.set(msg.id, msg);
}

function flushSave(tabId: string) {
  const entry = pendingSaves.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  // doSaveCallback owns the delete + isExecutionActive check + actual write.
  // Calling it directly here makes flush semantically "fire now instead
  // of waiting for the timer" — same isExecutionActive guard applies (a tab
  // currently streaming can't be flushed; caller paths that need a
  // sync flush also clear streaming first, e.g. removeTab).
  doSaveCallback(tabId);
}

function doSaveCallback(tabId: string) {
  const entry = pendingSaves.get(tabId);
  if (!entry) return;
  const tab = tabs.get(tabId);
  if (!tab) {
    pendingSaves.delete(tabId);
    return;
  }
  // Streaming mid-execution → DON'T delete the entry (old overwrite-all code
  // dropped it and relied on the next save rewriting everything; delta
  // save can't recover lost dirtyMsgs that way). Re-arm the timer
  // instead so we retry next window.
  if (tab.isExecutionActive) {
    entry.timer = setTimeout(() => doSaveCallback(tabId), saveThrottleMs);
    return;
  }
  pendingSaves.delete(tabId);
  const dirty = [...entry.dirtyMsgs.values()];
  saveAgentMessagesDelta(tab.sessionId, dirty, entry.deletedIds).catch((err) => {
    console.error('[agentTabStore] saveAgentMessagesDelta failed', err);
  });
}

/**
 * Trim in-memory tab.messages down to inMemoryMax. Cut point snaps
 * forward to the nearest user msg so MessageList never renders a
 * "headless" execution (agent msgs without their preceding user msg).
 *
 * Called only from setExecutionActive(false) — execution boundary is the one
 * unambiguous moment when trimming can't surprise the user (no live
 * content gets cut). Used to live inside doSave but that conflated
 * persistence timing with in-memory bookkeeping.
 */
function trimMessagesInMemory(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab || tab.messages.length <= inMemoryMax) return;
  const target = tab.messages.length - inMemoryMax;
  let cutAt = target;
  for (let i = target; i < tab.messages.length; i++) {
    if (tab.messages[i].type === 'user') { cutAt = i; break; }
  }
  if (cutAt === 0) return;
  const trimmed = tab.messages.slice(cutAt);
  tabs.set(tabId, { ...tab, messages: trimmed });
  notify(tabId);
}

// ── State updaters ──

function update(tabId: string, mutator: (prev: AgentTabState) => AgentTabState) {
  const prev = tabs.get(tabId);
  if (!prev) return;
  const next = mutator(prev);
  if (next === prev) return;
  tabs.set(tabId, next);
  notify(tabId);
}

// upsert-by-id, preserving original timestamp on replace so timeline
// ordering doesn't jump when finalize lands after streaming.
function upsertById(prev: AgentMsg[], built: AgentMsg): AgentMsg[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].id === built.id) {
      const next = prev.slice();
      next[i] = { ...built, timestamp: prev[i].timestamp };
      return next;
    }
  }
  return [...prev, built];
}

// ── Lifecycle actions ──

export interface InitTabOpts {
  sessionId: string;
  provider: AgentProvider;
  intent?: AgentPrefs;
}

export function initTab(tabId: string, opts: InitTabOpts) {
  if (tabs.has(tabId)) return;  // idempotent
  const historyLoadToken = Symbol();
  historyLoadTokens.set(tabId, historyLoadToken);
  const initial: AgentTabState = {
    sessionId: opts.sessionId,
    provider: opts.provider,
    messages: [],
    pendingSends: [],
    promotedClientMsgIds: new Set(),
    currentPlan: '',
    backgroundTasks: [],
    dismissedTaskIds: new Set(),
    isExecutionActive: false,
    // Warm-start from intent so StatusBar doesn't flash "—" on mount.
    // First capabilities event overwrites with backend-reported actual.
    actualModel: opts.intent?.model ?? null,
    actualEffort: opts.intent?.effort ?? 'medium',
    actualPermissionMode: opts.intent?.permissionMode ?? 'default',
    costUsd: undefined,
    numTurns: undefined,
    contextUsage: null,
    rateLimits: [],
    credits: null,
    capabilities: null,
    pendingPermission: null,
    pendingPicker: null,
    localPicker: null,
    authRequired: null,
    authBusy: false,
    authError: null,
    loginPrompt: null,
    loginBusy: false,
    initStatus: 'starting',
    initPhase: null,
    initError: null,
  };
  tabs.set(tabId, initial);
  notify(tabId);

  // Async IDB load — only the latest `inMemoryMax` rows, not the whole
  // session. With IDB now unbounded, pulling everything would blow up
  // RAM on long histories. Older rows stay in IDB; a future Load earlier
  // UI would surface them on demand.
  //
  // Backend events that fire before this resolves write into `messages`
  // first; load merges loaded-before-current with ID dedupe so the new
  // entries aren't clobbered.
  loadAgentMessagesLatest(opts.sessionId, inMemoryMax).then((loaded) => {
    if (historyLoadTokens.get(tabId) !== historyLoadToken) return;
    if (loaded.length === 0) return;
    const current = tabs.get(tabId);
    if (!current) return;  // tab removed during load
    const currentIds = new Set(current.messages.map((m) => m.id));
    const filteredLoaded = loaded.filter((m) => !currentIds.has(m.id));
    if (filteredLoaded.length === 0) return;
    tabs.set(tabId, { ...current, messages: [...filteredLoaded, ...current.messages] });
    notify(tabId);
  }).catch((err) => {
    console.error('[agentTabStore] loadAgentMessagesLatest failed', err);
  });
}

export function removeTab(tabId: string) {
  historyLoadTokens.delete(tabId);
  flushSave(tabId);
  clearChunkBuffer(tabId);
  tabs.delete(tabId);
  listeners.delete(tabId);
}

// ── Message actions ──

export function upsertMessage(tabId: string, msg: AgentMsg) {
  if (!tabs.has(tabId)) return;
  // 清掉該 msgId 的 pending chunk buffer — 如果剛收到 finalize message
  // (provider 的 finalize content 是完整文字、已含所有 stream chunks)，
  // buffer 裡尚未 flush 的 delta 是 stale；不清會被下次 flush 追加到已
  // finalize 的 content 後面，導致結尾重複（例如「...可以開工。工。」）。
  // Race window: finalize 在 33ms flush timer 觸發前抵達。
  const buffer = pendingChunks.get(tabId);
  if (buffer?.has(msg.id)) {
    buffer.delete(msg.id);
    if (buffer.size === 0) clearChunkBuffer(tabId);
  }
  update(tabId, (prev) => ({ ...prev, messages: upsertById(prev.messages, msg) }));
  // Persist the position-stable timestamp upsertById kept in-memory — when a
  // finalize `reply` replaces an earlier streaming card, upsertById preserves the
  // EARLY (streaming) timestamp, but `msg` still carries buildAgentMsg's fresh
  // finalize-time stamp. Persisting `msg` would make reload's by-session-time sort
  // clump every finalized reply at execution-end, breaking interleaving with tool cards.
  const stored = tabs.get(tabId)?.messages.find((m) => m.id === msg.id) ?? msg;
  markDirty(tabId, stored);
}

// ── Stream chunk batching ──
//
// Raw incoming chunks (one per IPC 'agent:onStream' event) come in
// fast — 30-60/sec for Claude — and naively writing to the store
// per chunk would re-render MessageList just as often. We buffer
// deltas per (tabId, msgId) and flush at most ~30 Hz (33ms timer).
// Visual streaming looks identical at 30 Hz vs 60 Hz for text; we
// halve the React work for free.
//
// Buffer shape: `pendingChunks[tabId][msgId] = { type, delta }`.
// Concurrent msgIds in the same tab are rare in practice (provider
// finalizes one before starting the next) but the nested map keeps
// them independent if it ever happens.

interface ChunkBuffer { type: 'text' | 'thinking'; delta: string }
const pendingChunks = new Map<string, Map<string, ChunkBuffer>>();
const chunkTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CHUNK_FLUSH_INTERVAL_MS = 33;

function scheduleChunkFlush(tabId: string) {
  if (chunkTimers.has(tabId)) return;  // already scheduled
  const t = setTimeout(() => {
    chunkTimers.delete(tabId);
    flushChunkBuffer(tabId);
  }, CHUNK_FLUSH_INTERVAL_MS);
  chunkTimers.set(tabId, t);
}

function clearChunkBuffer(tabId: string) {
  const t = chunkTimers.get(tabId);
  if (t) { clearTimeout(t); chunkTimers.delete(tabId); }
  pendingChunks.delete(tabId);
}

function flushChunkBuffer(tabId: string) {
  const buffer = pendingChunks.get(tabId);
  if (!buffer || buffer.size === 0) return;
  pendingChunks.delete(tabId);
  const tab = tabs.get(tabId);
  if (!tab) return;  // tab gone — drop buffer

  // Apply every buffered (msgId, delta) to a single new messages
  // array. One reducer pass, one notify — even if 200 chunks landed
  // in the 33 ms window for the same msgId, MessageList commits once.
  let messages = tab.messages;
  const touchedIds = new Set<string>();
  // The msgId that received the most recent chunk in this flush — the single
  // "live" stream. Any earlier message still flagged streaming is a completed
  // segment (boundary-split mints a fresh message per tool boundary), so it is
  // settled below. Buffer is insertion-ordered → last key = most recent.
  let activeMsgId: string | undefined;
  for (const [msgId, { type, delta }] of buffer) {
    activeMsgId = msgId;
    let found = false;
    // Wire streamType ('text' | 'thinking') maps to renderer-side variants:
    //   'text'     → reply       (assistant markdown reply)
    //   'thinking' → fold_text   (label='Thinking', body.tone='muted')
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.id !== msgId) continue;
      const next = messages.slice();
      if (type === 'text' && m.type === 'reply') {
        next[i] = { ...m, content: (m.content as string) + delta, streaming: tab.isExecutionActive };
      } else if (type === 'thinking' && m.type === 'fold_text') {
        const prev = m.body?.content ?? '';
        next[i] = {
          ...m,
          body: { content: prev + delta, tone: 'muted' as const },
          streaming: tab.isExecutionActive,
        };
      } else {
        // Type mismatch — unexpected, skip safely.
        found = true;
        break;
      }
      messages = next;
      touchedIds.add(msgId);
      found = true;
      break;
    }
    if (!found) {
      if (type === 'text') {
        messages = [
          ...messages,
          {
            id: msgId,
            type: 'reply',
            content: delta,
            streaming: tab.isExecutionActive,
            provider: tab.provider,
            timestamp: Date.now(),
          } as AgentMsg,
        ];
      } else {
        // Thinking stream → fold_text placeholder. Label matches what the
        // provider will send on finalize (`Thinking`); body accumulates deltas.
        messages = [
          ...messages,
          {
            id: msgId,
            type: 'fold_text',
            label: 'Thinking',
            body: { content: delta, tone: 'muted' as const },
            streaming: tab.isExecutionActive,
            provider: tab.provider,
            timestamp: Date.now(),
          } as AgentMsg,
        ];
      }
      touchedIds.add(msgId);
    }
  }
  // Single active caret: settle any message still flagged streaming that ISN'T
  // the live stream. Without this, boundary-split (a new reply per tool boundary,
  // agent-providers#27) leaves every prior segment's caret blinking until execution-end
  // idle. Persist the settled text now (markDirty) so its final content lands in
  // IDB at the boundary, matching setExecutionActive(false)'s clear path — appendChunk
  // itself skips markDirty (partials shouldn't persist), so this is the write.
  let settled = false;
  const cleared = messages.map((m) => {
    const streamMessage = m.type === 'reply' || m.type === 'fold_text';
    // A chunk may arrive after execution idle because provider notifications and
    // prompt settlement are independent. It is still content: show it, but do not
    // resurrect the caret/execution. Persist every touched settled message now,
    // because no later idle transition is guaranteed to flush it.
    if (!tab.isExecutionActive && streamMessage && (touchedIds.has(m.id) || m.streaming)) {
      settled = true;
      const s = m.streaming ? ({ ...m, streaming: false } as AgentMsg) : m;
      markDirty(tabId, s);
      return s;
    }
    if (tab.isExecutionActive && streamMessage && m.streaming && m.id !== activeMsgId) {
      settled = true;
      const s = { ...m, streaming: false } as AgentMsg;
      markDirty(tabId, s);
      return s;
    }
    return m;
  });
  if (settled) messages = cleared;
  tabs.set(tabId, { ...tab, messages });
  notify(tabId);
}

export function appendChunk(
  tabId: string,
  chunkMsgId: string,
  delta: string,
  type: 'text' | 'thinking',
) {
  // Drop chunks for tabs that don't exist yet — initTab may not have
  // run, or the tab was already removed. Mirrors the pre-batching
  // behaviour (`tabs.get(tabId)` guard was the first line).
  if (!tabs.has(tabId)) return;

  let buffer = pendingChunks.get(tabId);
  if (!buffer) { buffer = new Map(); pendingChunks.set(tabId, buffer); }
  const existing = buffer.get(chunkMsgId);
  if (existing) {
    // Same msgId in the same window — concatenate deltas. Type is
    // taken from the first chunk; mid-stream type changes shouldn't
    // happen.
    existing.delta += delta;
  } else {
    buffer.set(chunkMsgId, { type, delta });
  }
  scheduleChunkFlush(tabId);
  // Persistence is decided at flush time from the current execution status:
  // active chunks remain transient, while chunks that arrive after idle are
  // immediately marked dirty because no later idle transition is guaranteed.
}

// ── Server-owned send queue (optimistic chips + snapshot reconcile) ──

/**
 * Optimistically record an eager-sent submission as a pending chip (confirmed
 * by the next server snapshot). Called at submit time, BEFORE the send round-
 * trips, so the CLI-style instant-feedback chip shows without waiting.
 */
export function enqueuePendingSend(
  tabId: string,
  clientMsgId: string,
  content: string,
  images?: string[],
  files?: AgentFile[],
) {
  update(tabId, (prev) => ({
    ...prev,
    pendingSends: [
      ...prev.pendingSends,
      {
        clientMsgId,
        content,
        ...(images && images.length > 0 ? { images } : {}),
        ...(files && files.length > 0 ? { files } : {}),
        confirmed: false,
      },
    ],
  }));
}

/**
 * Apply an authoritative server queue snapshot: reconcile against the optimistic
 * pending chips, promote any newly-running item into the timeline as a user
 * bubble, and update the chip list. See reconcileQueueSnapshot.
 */
export function applyQueueSnapshot(tabId: string, items: AgentQueueItem[]) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const { pending, promote, promoted, anomalies } = reconcileQueueSnapshot(
    tab.pendingSends,
    tab.promotedClientMsgIds,
    items,
  );
  // Never drop / mismatch silently: surface every snapshot↔optimistic
  // discrepancy to the persistent main log (debugLog), and console.warn the
  // potential-message-loss case so it's loud in devtools too.
  for (const a of anomalies) {
    debugLog('agent-queue', `tab=${formatTabLogId(tabId)} ${a.kind} clientMsgId=${a.clientMsgId}`);
    if (a.kind === 'dropped-confirmed-vanished') {
      console.warn(
        '[agent-queue] a queued message vanished from the server queue before running ' +
        '(connection lost / respawn) — chip dropped, NOT auto-resent',
        { tabId, clientMsgId: a.clientMsgId },
      );
    }
  }
  // Promote first (adds timeline user bubbles + marks dirty for persistence),
  // then commit the reduced chip list + promoted set in one update.
  for (const p of promote) {
    upsertMessage(tabId, {
      id: `user-${p.clientMsgId}`,
      type: 'user',
      content: p.content,
      timestamp: Date.now(),
      ...(p.images && p.images.length > 0 ? { images: p.images } : {}),
      ...(p.files && p.files.length > 0 ? { files: p.files } : {}),
    });
  }
  update(tabId, (prev) => ({ ...prev, pendingSends: pending, promotedClientMsgIds: promoted }));
}

/**
 * Optimistically drop a not-yet-running pending chip (the IPC cancel is emitted
 * separately by the caller). The server's next snapshot confirms; if it raced to
 * 'running' first, the snapshot still carries it and reconcile re-promotes it.
 */
export function cancelPendingSend(tabId: string, clientMsgId: string) {
  update(tabId, (prev) => {
    const pendingSends = prev.pendingSends.filter((p) => p.clientMsgId !== clientMsgId);
    return pendingSends.length === prev.pendingSends.length ? prev : { ...prev, pendingSends };
  });
}

/**
 * Drop ALL optimistic pending chips (ESC / stop). The server clears its own
 * queue in parallel; this clears the local optimistic view (incl. items not yet
 * confirmed by a snapshot, which reconcile would otherwise keep). The running
 * execution — already promoted to a timeline bubble — is unaffected.
 */
export function clearPendingSends(tabId: string) {
  update(tabId, (prev) =>
    prev.pendingSends.length === 0 ? prev : { ...prev, pendingSends: [] }
  );
}

export async function clearMessages(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  // Invalidate the init-time IndexedDB read before changing either memory or
  // storage. A read already in flight may still resolve with the pre-clear
  // snapshot, but its epoch check will now discard that result.
  historyLoadTokens.delete(tabId);
  // Drop deltas waiting for the 33ms renderer throttle. Otherwise their timer
  // can append a stale reply immediately after messages becomes empty.
  clearChunkBuffer(tabId);
  // Drop any queued dirty snapshots outright — don't flushSave, because
  // if the tab is streaming flushSave just re-arms the timer, then a
  // later fire would re-write pre-clear msgs back to IDB after we wipe
  // the session. clearAgentSession is authoritative; nothing in the
  // window before it should survive.
  const entry = pendingSaves.get(tabId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingSaves.delete(tabId);
  }
  // Clear background tasks too so every renderer-owned history surface follows
  // the same visible-history wipe.
  update(tabId, (prev) => ({ ...prev, messages: [], backgroundTasks: [], dismissedTaskIds: new Set(), pendingSends: [], promotedClientMsgIds: new Set() }));
  await clearAgentSession(tab.sessionId).catch((err) => {
    console.error('[agentTabStore] clearAgentSession failed', err);
  });
}

// ── Status actions (dumb setters — backend authoritative) ──

export function setExecutionActive(tabId: string, value: boolean) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const wasStreaming = tab.isExecutionActive;
  if (wasStreaming === value) return;

  // streaming → idle: flush any pending chunks **first** so the
  // last partial deltas land in messages before we clear the
  // `streaming: true` flag below. Otherwise the final chunks would
  // be either dropped (clearChunkBuffer) or appear without the
  // cursor having been visible (race between timer + finalize msg).
  if (wasStreaming && !value) {
    flushChunkBuffer(tabId);
  }

  // Re-read tab — flushChunkBuffer may have written new messages.
  // Using `tab` (pre-flush snapshot) here would clobber those writes.
  const cur = tabs.get(tabId);
  if (!cur) return;
  let nextMessages = cur.messages;
  let mutated = false;
  // Streaming → idle: clear `streaming` flag on any text/thinking that
  // never received a finalize message, and mark each one dirty so the
  // delta save persists the final settled state. This is the ONLY path
  // that writes text/thinking msgs to IDB — appendChunk deliberately
  // skips markDirty (partials shouldn't persist), so without this loop
  // streamed responses would never land in storage.
  if (wasStreaming && !value) {
    const cleared = cur.messages.map((m) => {
      if ((m.type === 'reply' || m.type === 'fold_text') && m.streaming) {
        mutated = true;
        const settled = { ...m, streaming: false };
        markDirty(tabId, settled);
        return settled;
      }
      return m;
    });
    if (mutated) nextMessages = cleared;
  }
  tabs.set(tabId, {
    ...cur,
    isExecutionActive: value,
    messages: nextMessages,
    // Auto-dismiss any in-flight picker at execution end — provider's abort
    // path already resolved its pending Promise, so leaving the UI up
    // would be a ghost panel.
    pendingPicker: wasStreaming && !value ? null : cur.pendingPicker,
  });
  notify(tabId);

  // Execution end: trim in-memory once (cap was off during streaming so the
  // execution could grow freely). markDirty above already scheduled the save
  // timer; trim snapshot has already been preserved in dirtyMsgs so
  // even if trim drops a msg here it'll still be persisted.
  if (wasStreaming && !value) {
    trimMessagesInMemory(tabId);
    // Ensure a save fires even if nothing was marked dirty above
    // (e.g. a execution that produced only non-text msgs already marked
    // via upsertMessage but whose throttle timer was reset by
    // streaming-skip retries). ensurePendingSave is idempotent.
    ensurePendingSave(tabId);
  }
}

export interface StatusPartial {
  state?: 'idle' | 'streaming' | string;
  costUsd?: number;
  numTurns?: number;
  contextUsage?: StatusSegment;
  rateLimits?: StatusSegment[];
  credits?: StatusSegment;
}

export function setStatus(tabId: string, partial: StatusPartial) {
  // NOTE: model is intentionally NOT a status field. The displayed model
  // (actualModel) is driven solely by the capabilities channel + intent seed
  // + explicit edits — never by the per-execution resolved model. This keeps a
  // selected alias (default/sonnet/haiku) stable instead of flip-flopping to
  // the concrete resolved id each execution. See claude.ts alias-resolution block.
  update(tabId, (prev) => {
    const next: AgentTabState = { ...prev };
    if (partial.costUsd != null) next.costUsd = partial.costUsd;
    if (partial.numTurns != null) next.numTurns = partial.numTurns;
    if (partial.contextUsage) next.contextUsage = partial.contextUsage;
    if (Array.isArray(partial.rateLimits) && partial.rateLimits.length > 0) {
      next.rateLimits = partial.rateLimits;
    }
    if (partial.credits) next.credits = partial.credits;
    return next;
  });
  // Streaming flag transition is handled separately via setExecutionActive —
  // the IPC binder in PR 3 will call both based on status.state.
}

export function setPlan(tabId: string, content: string) {
  update(tabId, (prev) => ({ ...prev, currentPlan: content }));
}

/**
 * Apply a background-task event (executionId-less side-channel).
 *   - started/updated/progress/done: upsert the single task by id, preserving
 *     first-seen order; later events merge over earlier state (the provider
 *     already merged, so we just replace the entry).
 *   - snapshot: reconcile the authoritative list — upsert each, preserving
 *     existing order for known ids and appending new ones. (We don't drop
 *     tasks absent from a snapshot: claude's snapshot only carries the
 *     still-running set at a execution boundary; completed ones must stay visible.)
 */
export function applyTaskEvent(tabId: string, event: TaskEvent) {
  update(tabId, (prev) => {
    const incoming = event.kind === 'snapshot' ? (event.tasks ?? []) : (event.task ? [event.task] : []);
    if (incoming.length === 0) return prev;
    const byId = new Map(prev.backgroundTasks.map((t) => [t.id, t]));
    for (const t of incoming) {
      if (prev.dismissedTaskIds.has(t.id)) continue; // user deleted it — never resurrect
      byId.set(t.id, t);
    }
    return { ...prev, backgroundTasks: [...byId.values()] };
  });
}

/**
 * Remove a background task card and tombstone its id so a later task_notification
 * can't bring it back. For a still-running task the caller is expected to have
 * already sent stopTask to the SDK — this only touches renderer-local display.
 */
export function removeBackgroundTask(tabId: string, id: string) {
  update(tabId, (prev) => {
    const present = prev.backgroundTasks.some((t) => t.id === id);
    if (!present && prev.dismissedTaskIds.has(id)) return prev; // already gone + tombstoned
    const dismissedTaskIds = new Set(prev.dismissedTaskIds);
    dismissedTaskIds.add(id);
    return { ...prev, backgroundTasks: prev.backgroundTasks.filter((t) => t.id !== id), dismissedTaskIds };
  });
}

export function setCapabilities(tabId: string, caps: Capabilities | null) {
  update(tabId, (prev) => {
    if (caps === null) {
      // Clear capabilities — used during retryInit so cycle buttons
      // hide until the next capabilities event re-populates. Leaves
      // actual* untouched (they're warm-started from intent on next
      // initTab if the tab is fully reset).
      return { ...prev, capabilities: null };
    }
    return {
      ...prev,
      capabilities: caps,
      // Backend-reported actuals overwrite — no fallback to intent.
      // Provider/backend is responsible for any fallback logic;
      // renderer just reflects what was reported.
      actualModel: caps.currentModel ?? prev.actualModel,
      actualEffort: caps.currentEffort ?? prev.actualEffort,
      actualPermissionMode: caps.currentPermissionMode ?? prev.actualPermissionMode,
    };
  });
}

// ── Optimistic actual updates (cycle handlers) ──

export function setActualModel(tabId: string, model: string) {
  update(tabId, (prev) => ({ ...prev, actualModel: model }));
}
export function setActualEffort(tabId: string, effort: string) {
  update(tabId, (prev) => ({ ...prev, actualEffort: effort }));
}
export function setActualPermissionMode(tabId: string, mode: string) {
  update(tabId, (prev) => ({ ...prev, actualPermissionMode: mode }));
}

// ── Decision actions ──

export function setPendingPermission(tabId: string, perm: PendingPermission | null) {
  update(tabId, (prev) => ({ ...prev, pendingPermission: perm }));
}

export function setPendingPicker(tabId: string, picker: PendingPicker | null) {
  update(tabId, (prev) => ({ ...prev, pendingPicker: picker }));
}

export function setLocalPicker(tabId: string, lp: LocalPicker | null) {
  update(tabId, (prev) => ({ ...prev, localPicker: lp }));
}

// ── Auth / Init actions ──

export function setAuthRequired(tabId: string, auth: { provider: string } | null) {
  update(tabId, (prev) => ({ ...prev, authRequired: auth }));
}

export function setAuthBusy(tabId: string, busy: boolean) {
  update(tabId, (prev) => ({ ...prev, authBusy: busy }));
}

export function setAuthError(tabId: string, err: string | null) {
  update(tabId, (prev) => ({ ...prev, authError: err }));
}

// ── Interactive device-flow login actions (see features copilot-device-login) ──

/** Mark login as started (button click). Clears any prior prompt/error. */
export function beginLogin(tabId: string) {
  update(tabId, (prev) => ({ ...prev, loginBusy: true, loginPrompt: null, authError: null }));
}

/** Store the verification URL + code emitted while login polls. */
export function setLoginPrompt(tabId: string, prompt: AgentLoginPrompt) {
  update(tabId, (prev) => ({ ...prev, loginPrompt: prompt }));
}

/**
 * Apply the terminal login result. On success clears the AuthPane (authRequired
 * → null); on cancel just resets; on failure surfaces the error. Always clears
 * loginBusy + loginPrompt.
 */
export function finishLogin(tabId: string, result: AgentLoginResult) {
  update(tabId, (prev) => ({
    ...prev,
    loginBusy: false,
    loginPrompt: null,
    authRequired: result.ok ? null : prev.authRequired,
    authError: result.ok || result.cancelled ? null : (result.error ?? 'Login failed.'),
  }));
}

export function setInitStatus(
  tabId: string,
  status: 'starting' | 'ready' | 'failed',
  error: string | null = null,
  phase: AgentInitPhase | null = null,
) {
  update(tabId, (prev) => ({ ...prev, initStatus: status, initError: error, initPhase: phase }));
}

// ── Selectors ──

export interface MessageTimeline {
  /** Messages rendered directly in the timeline, in store order. */
  topLevel: AgentMsg[];
  /** Subagent activity, grouped by the outer Agent tool_use id it nests under.
   *  MessageList renders `children[card.id]` inside that card. See subagent-display. */
  children: Record<string, AgentMsg[]>;
}

/**
 * Linear timeline selector. Every message stays in store order unless it has
 * an earlier, visible `parentToolUseId`, in which case it is rendered inside
 * that tool card. Missing parents fall back to top-level so metadata can never
 * hide content. Not memoized here; MessageList wraps it in useMemo.
 */
export function buildMessageTimeline(messages: AgentMsg[]): MessageTimeline {
  const topLevel: AgentMsg[] = [];
  const children: Record<string, AgentMsg[]> = {};
  const nestableParentIds = new Set<string>();

  for (const msg of messages) {
    // Subagent-emitted message → nest under its outer Agent card (parentToolUseId
    // === that card's msgId) instead of the main list. An earlier parent is the
    // only condition that changes placement; transport execution boundaries do not.
    const parentId = msg.parentToolUseId;
    if (parentId && nestableParentIds.has(parentId)) {
      (children[parentId] ??= []).push(msg);
    } else {
      // Parent not found — fail-visible at top-level rather than dropping data.
      topLevel.push(msg);
      // AgentMessage currently exposes nested content only for fold_code tool
      // cards. Never place children under a row that cannot render them.
      if (msg.type === 'fold_code') nestableParentIds.add(msg.id);
    }
  }

  return { topLevel, children };
}

// ── Test helpers ──

/** Reset module state. Tests only. */
export function __resetStoreForTests() {
  for (const { timer } of pendingSaves.values()) clearTimeout(timer);
  pendingSaves.clear();
  for (const t of chunkTimers.values()) clearTimeout(t);
  chunkTimers.clear();
  pendingChunks.clear();
  tabs.clear();
  listeners.clear();
  historyLoadTokens.clear();
  saveThrottleMs = DEFAULT_THROTTLE_MS;
  inMemoryMax = DEFAULT_IN_MEMORY_MAX;
}

/** Read internal config. Tests only. */
export function __getCapsForTests() {
  return { saveThrottleMs, inMemoryMax };
}

/** Direct read for tests that don't want to set up React. */
export function __getTabForTests(tabId: string) {
  return tabs.get(tabId);
}

/** Direct write for tests that need to seed state without going through
 *  initTab's async IDB load path. */
export function __setTabForTests(tabId: string, state: AgentTabState) {
  tabs.set(tabId, state);
  notify(tabId);
}

/** Inspect pending save state. Tests only. */
export function __getPendingSaveForTests(tabId: string) {
  return pendingSaves.get(tabId);
}

/** Subscribe to a tab's notify channel directly. Tests only — production
 *  callers should use `useAgentTab` which wires React's useSyncExternalStore. */
export function __subscribeForTests(tabId: string, listener: () => void) {
  return subscribe(tabId, listener);
}
