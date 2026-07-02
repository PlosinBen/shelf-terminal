import { onAgent, emitAgent } from './events';
import { buildAgentMsg } from './agent-message-builder';
import { debugLog } from './debugLog';
import {
  peekAgentTab,
  appendChunk,
  applyQueueSnapshot,
  setAuthRequired,
  setCapabilities,
  setInitStatus,
  setPendingPermission,
  setPendingPicker,
  setPlan,
  applyTaskEvent,
  setStatus,
  setStreaming,
  upsertMessage,
  type Capabilities,
} from './agentTabStore';

// Bridge layer: typed inbound agent events → agentTabStore actions.
// Pure adapter — no business logic except payload-shape coercion and
// the plan-vs-message branch (plan goes to its own state, not the
// timeline). Caller (App.tsx mount) gets a cleanup function that
// detaches every subscription it installed.
//
// Why a function (not module-level subscribes): tests need to be able
// to assert subscriptions don't trigger without a deliberate call. Also
// the binder pattern matches bindAgentIPCGroup, so App.tsx wiring is
// symmetric.
export function bindAgentStoreSubscriptions(): () => void {
  const offMessage = onAgent('agent:onMessage', ({ tabId, msg }) => {
    const mt = (msg as any)?.msgType;
    // Renderer receive-hop trace (→ main log at info/debug). The last leg of the
    // chain: an event in main's wire-rx / session-event trace but NOT here means
    // it never crossed IPC; here-but-not-rendered narrows it to buildAgentMsg /
    // store. See connection-wedge trace.
    debugLog('agent-rx', `msg tab=${tabId.slice(0, 8)} msgType=${mt}`);
    const tab = peekAgentTab(tabId);
    if (!tab) {
      debugLog('agent-rx', `DROP uninitialized tab=${tabId.slice(0, 8)} msgType=${mt}`);
      console.warn('[agent] message for uninitialized tab — dropping', { tabId, msgType: mt });
      return;
    }
    const built = buildAgentMsg(msg, tab.provider);
    if (!built) {
      // Unknown msgType (buildAgentMsg default → null). Real content being
      // dropped on the renderer side — log so an unhandled render primitive is
      // visible instead of a message silently not showing. See background-tasks#5.
      debugLog('agent-rx', `DROP unhandled msgType tab=${tabId.slice(0, 8)} msgType=${mt}`);
      console.warn('[agent] unhandled msgType — message dropped, not rendered', { tabId, msgType: mt });
      return;
    }
    upsertMessage(tabId, built);
  });

  // Plan side-channel — state update, not a timeline entry. Provider emits
  // a top-level `{ type:'plan' }` wire message; main forwards over IPC.AGENT_PLAN;
  // bus surfaces it as `agent:onPlan`. We route it straight to the store's
  // currentPlan; the sticky PlanPanel reads from there.
  const offPlan = onAgent('agent:onPlan', ({ tabId, content }) => {
    setPlan(tabId, content);
  });

  // Background-task side-channel — turnId-less; main forwards over
  // IPC.AGENT_BACKGROUND_TASKS; bus surfaces it as `agent:onBackgroundTasks`.
  // Upserts into the store's backgroundTasks; BackgroundTasksPanel reads it.
  const offBackgroundTasks = onAgent('agent:onBackgroundTasks', ({ tabId, event }) => {
    applyTaskEvent(tabId, event);
  });

  // Server-owned send-queue snapshot — turnId-less; main forwards over
  // IPC.AGENT_QUEUE; bus surfaces it as `agent:onQueue`. Reconciles against the
  // optimistic pending chips + promotes newly-running sends into the timeline.
  const offQueue = onAgent('agent:onQueue', ({ tabId, items }) => {
    applyQueueSnapshot(tabId, items);
  });

  const offStream = onAgent('agent:onStream', ({ tabId, chunk }) => {
    const c = chunk as any;
    const chunkMsgId: string | undefined = c.msgId;
    const chunkType: 'text' | 'thinking' = c.type === 'thinking' ? 'thinking' : 'text';
    const delta: string = c.content ?? '';
    if (!chunkMsgId || !delta) return;
    appendChunk(tabId, chunkMsgId, delta, chunkType);
  });

  const offStatus = onAgent('agent:onStatus', ({ tabId, status }) => {
    const s = status as any;
    // Stream state is a discrete flag; status partial bundles all other
    // status fields. Splitting keeps setStreaming pure (no field grab
    // bag) and lets setStreaming(false)'s turn-end side effects (clear
    // streaming flag on in-flight chunks + requestSave) fire on the
    // exact transition.
    if (s.state === 'streaming') setStreaming(tabId, true);
    else if (s.state === 'idle' || s.state === 'done') setStreaming(tabId, false);
    setStatus(tabId, {
      costUsd: s.costUsd,
      numTurns: s.numTurns,
      contextUsage: s.contextUsage,
      rateLimits: s.rateLimits,
    });
  });

  const offCapabilities = onAgent('agent:onCapabilities', ({ tabId, caps }) => {
    setCapabilities(tabId, caps as Capabilities);
  });

  const offPermission = onAgent('agent:onPermissionRequest', ({ tabId, req }) => {
    const r = req as any;
    setPendingPermission(tabId, {
      toolUseId: r.toolUseId,
      toolName: r.toolName,
      input: r.input ?? {},
    });
  });

  const offPicker = onAgent('agent:onPickerRequest', ({ tabId, req }) => {
    const r = req as any;
    if (typeof r?.id !== 'string' || !Array.isArray(r?.prompts)) return;
    // Latest-wins: if a picker is already pending, resolve it as
    // cancelled so the provider's pending Promise settles. Then install
    // the new picker. Provider isn't expected to send concurrent pickers
    // in normal flow; treating it as a race keeps UI state coherent.
    const tab = peekAgentTab(tabId);
    if (tab?.pendingPicker) {
      emitAgent('agent:resolvePicker', {
        tabId,
        pickerId: tab.pendingPicker.id,
        payload: { cancelled: true },
      });
    }
    setPendingPicker(tabId, { id: r.id, prompts: r.prompts });
  });

  const offAuth = onAgent('agent:onAuthRequired', ({ tabId, provider }) => {
    setAuthRequired(tabId, { provider });
  });

  const offInit = onAgent('agent:onInitStatus', ({ tabId, status }) => {
    setInitStatus(
      tabId,
      status.state,
      status.state === 'failed' ? status.reason : null,
      status.state === 'starting' ? status.phase ?? null : null,
    );
  });

  return () => {
    offMessage();
    offPlan();
    offBackgroundTasks();
    offQueue();
    offStream();
    offStatus();
    offCapabilities();
    offPermission();
    offPicker();
    offAuth();
    offInit();
  };
}
