import { useSyncExternalStore } from 'react';
import type { AgentMsg } from './components/AgentMessage';
import type { AgentPrefs, AgentProvider, AuthMethod } from '../shared/types';
import { loadAgentMessagesLatest, saveAgentMessagesDelta, clearAgentSession } from './storage/agent-history';

// Per-tab store for agent UI state. Split from store.ts because the
// global store rebuilds its snapshot on every change — every useStore
// consumer re-renders. Agent state changes (stream chunks, status
// pings) fire dozens of times per turn; bundling them with project /
// settings would force every component to re-render. This store
// notifies only the listeners registered for the tab that changed.
//
// Lifecycle: AgentView calls initTab on mount and removeTab on unmount
// (next PR wires this up). Backend events route here via the typed bus
// (events/ipc-agent.ts → store subscriptions installed by App.tsx in
// PR 3). For now this module is pure data + no subscribers.

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

export interface QueuedMessage {
  id: string;
  content: string;
}

export interface AgentTabState {
  // identity
  sessionId: string;
  provider: AgentProvider;

  // domain
  messages: AgentMsg[];
  queuedMessages: QueuedMessage[];
  currentPlan: string;

  // status (display only — what backend reports)
  isStreaming: boolean;
  actualModel: string | null;
  actualEffort: string;
  actualPermissionMode: string;
  costUsd: number | undefined;
  numTurns: number | undefined;
  contextUsage: StatusSegment | null;
  rateLimits: StatusSegment[];

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

  // init
  initStatus: 'starting' | 'ready' | 'failed';
  initError: string | null;
}

// ── Module-scoped state ──

type Listener = () => void;
const tabs = new Map<string, AgentTabState>();
const listeners = new Map<string, Set<Listener>>();

// Settings synced from App.tsx. inMemoryMax used to be clamped against
// an idbMax sibling; that was removed when IDB went unlimited via the
// append-only delta save refactor. in-memory still has a cap for RAM /
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
  // doSaveCallback owns the delete + isStreaming check + actual write.
  // Calling it directly here makes flush semantically "fire now instead
  // of waiting for the timer" — same isStreaming guard applies (a tab
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
  // Streaming mid-turn → DON'T delete the entry (old overwrite-all code
  // dropped it and relied on the next save rewriting everything; delta
  // save can't recover lost dirtyMsgs that way). Re-arm the timer
  // instead so we retry next window.
  if (tab.isStreaming) {
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
 * "headless" turn (agent msgs without their preceding user msg).
 *
 * Called only from setStreaming(false) — turn boundary is the one
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
  const initial: AgentTabState = {
    sessionId: opts.sessionId,
    provider: opts.provider,
    messages: [],
    queuedMessages: [],
    currentPlan: '',
    isStreaming: false,
    // Warm-start from intent so StatusBar doesn't flash "—" on mount.
    // First capabilities event overwrites with backend-reported actual.
    actualModel: opts.intent?.model ?? null,
    actualEffort: opts.intent?.effort ?? 'medium',
    actualPermissionMode: opts.intent?.permissionMode ?? 'default',
    costUsd: undefined,
    numTurns: undefined,
    contextUsage: null,
    rateLimits: [],
    capabilities: null,
    pendingPermission: null,
    pendingPicker: null,
    localPicker: null,
    authRequired: null,
    authBusy: false,
    authError: null,
    initStatus: 'starting',
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
  flushSave(tabId);
  clearChunkBuffer(tabId);
  tabs.delete(tabId);
  listeners.delete(tabId);
}

// ── Message actions ──

export function upsertMessage(tabId: string, msg: AgentMsg) {
  if (!tabs.has(tabId)) return;
  update(tabId, (prev) => ({ ...prev, messages: upsertById(prev.messages, msg) }));
  markDirty(tabId, msg);
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
  for (const [msgId, { type, delta }] of buffer) {
    let found = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.id !== msgId) continue;
      if (m.type !== 'text' && m.type !== 'thinking') { found = true; break; }  // unexpected, skip
      const next = messages.slice();
      next[i] = { ...m, content: (m.content as string) + delta, streaming: true };
      messages = next;
      found = true;
      break;
    }
    if (!found) {
      messages = [
        ...messages,
        {
          id: msgId,
          type,
          content: delta,
          streaming: true,
          provider: tab.provider,
          timestamp: Date.now(),
        } as AgentMsg,
      ];
    }
  }
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
  // Stream chunks deliberately skip requestSave — saving partials
  // would re-write the full message list every throttle window
  // during a long turn. doSave at turn end (setStreaming(false))
  // captures the final.
}

export function enqueueMessage(tabId: string, content: string) {
  update(tabId, (prev) => ({
    ...prev,
    queuedMessages: [...prev.queuedMessages, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, content }],
  }));
}

export function dequeueMessage(tabId: string): QueuedMessage | null {
  const tab = tabs.get(tabId);
  if (!tab || tab.queuedMessages.length === 0) return null;
  const next = tab.queuedMessages[0];
  tabs.set(tabId, { ...tab, queuedMessages: tab.queuedMessages.slice(1) });
  notify(tabId);
  return next;
}

export function cancelQueuedMessage(tabId: string, id: string) {
  update(tabId, (prev) => ({
    ...prev,
    queuedMessages: prev.queuedMessages.filter((q) => q.id !== id),
  }));
}

export function clearQueuedMessages(tabId: string) {
  update(tabId, (prev) =>
    prev.queuedMessages.length === 0 ? prev : { ...prev, queuedMessages: [] }
  );
}

export async function clearMessages(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab) return;
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
  update(tabId, (prev) => ({ ...prev, messages: [] }));
  await clearAgentSession(tab.sessionId).catch((err) => {
    console.error('[agentTabStore] clearAgentSession failed', err);
  });
}

// ── Status actions (dumb setters — backend authoritative) ──

export function setStreaming(tabId: string, value: boolean) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const wasStreaming = tab.isStreaming;
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
      if ((m.type === 'text' || m.type === 'thinking') && m.streaming) {
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
    isStreaming: value,
    messages: nextMessages,
    // Auto-dismiss any in-flight picker at turn end — provider's abort
    // path already resolved its pending Promise, so leaving the UI up
    // would be a ghost panel.
    pendingPicker: wasStreaming && !value ? null : cur.pendingPicker,
  });
  notify(tabId);

  // Turn end: trim in-memory once (cap was off during streaming so the
  // turn could grow freely). markDirty above already scheduled the save
  // timer; trim snapshot has already been preserved in dirtyMsgs so
  // even if trim drops a msg here it'll still be persisted.
  if (wasStreaming && !value) {
    trimMessagesInMemory(tabId);
    // Ensure a save fires even if nothing was marked dirty above
    // (e.g. a turn that produced only non-text msgs already marked
    // via upsertMessage but whose throttle timer was reset by
    // streaming-skip retries). ensurePendingSave is idempotent.
    ensurePendingSave(tabId);
  }
}

export interface StatusPartial {
  state?: 'idle' | 'streaming' | string;
  model?: string;
  costUsd?: number;
  numTurns?: number;
  contextUsage?: StatusSegment;
  rateLimits?: StatusSegment[];
}

export function setStatus(tabId: string, partial: StatusPartial) {
  update(tabId, (prev) => {
    const next: AgentTabState = { ...prev };
    if (partial.model) next.actualModel = partial.model;
    if (partial.costUsd != null) next.costUsd = partial.costUsd;
    if (partial.numTurns != null) next.numTurns = partial.numTurns;
    if (partial.contextUsage) next.contextUsage = partial.contextUsage;
    if (Array.isArray(partial.rateLimits) && partial.rateLimits.length > 0) {
      next.rateLimits = partial.rateLimits;
    }
    return next;
  });
  // Streaming flag transition is handled separately via setStreaming —
  // the IPC binder in PR 3 will call both based on status.state.
}

export function setPlan(tabId: string, content: string) {
  update(tabId, (prev) => ({ ...prev, currentPlan: content }));
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

export function setInitStatus(
  tabId: string,
  status: 'starting' | 'ready' | 'failed',
  error: string | null = null,
) {
  update(tabId, (prev) => ({ ...prev, initStatus: status, initError: error }));
}

// ── Selectors ──

export interface Turn { user?: AgentMsg; agent: AgentMsg[] }

/**
 * Turn grouping selector — pure derivation from messages. Not memoized
 * here; consumer (MessageList) wraps in useMemo. Logic mirrors the
 * existing AgentView turns useMemo so behaviour stays identical.
 */
export function buildTurns(messages: AgentMsg[]): Turn[] {
  const result: Turn[] = [];
  for (const msg of messages) {
    if (msg.type === 'user') {
      result.push({ user: msg, agent: [] });
    } else if (result.length === 0) {
      result.push({ agent: [msg] });
    } else {
      result[result.length - 1].agent.push(msg);
    }
  }
  return result;
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
