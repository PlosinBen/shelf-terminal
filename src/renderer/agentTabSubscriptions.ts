import { onAgent, emitAgent } from './events';
import { buildAgentMsg } from './agent-message-builder';
import {
  peekAgentTab,
  appendChunk,
  setAuthRequired,
  setCapabilities,
  setInitStatus,
  setPendingPermission,
  setPendingPicker,
  setPlan,
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
    const tab = peekAgentTab(tabId);
    if (!tab) return;  // tab not initialized yet — drop
    const built = buildAgentMsg(msg, tab.provider);
    if (!built) return;
    upsertMessage(tabId, built);
  });

  // Plan side-channel — state update, not a timeline entry. Provider emits
  // a top-level `{ type:'plan' }` wire message; main forwards over IPC.AGENT_PLAN;
  // bus surfaces it as `agent:onPlan`. We route it straight to the store's
  // currentPlan; the sticky PlanPanel reads from there.
  const offPlan = onAgent('agent:onPlan', ({ tabId, content }) => {
    setPlan(tabId, content);
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
    offStream();
    offStatus();
    offCapabilities();
    offPermission();
    offPicker();
    offAuth();
    offInit();
  };
}
