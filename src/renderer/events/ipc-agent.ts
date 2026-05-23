import type { AgentInitStatus } from '../../shared/types';
import { onAgent, emitAgent } from './types';

// Single global binder that wires window.shelfApi.agent.* IPC ↔ typed
// agent event bus. Caller (App.tsx mount) gets a cleanup function that
// removes every listener + subscription it created.
//
// Why module-level / global-once: per-tab listeners (the old AgentView
// pattern) tear down when the agent tab unmounts mid-stream, dropping
// IPC events the user could otherwise see on tab return. With the
// binder living at App.tsx lifetime, streams survive tab unmount.
// agentTabStore handles per-tab routing by tabId in payloads.
//
// Pure adapter — no business logic. Inbound: forward IPC callback args
// into a typed emit. Outbound: subscribe to bus event, call IPC method.
//
// `shelfApi` resolved at call time (not at module init) so tests can
// stub window.shelfApi before calling bindAgentIPCGroup().
export function bindAgentIPCGroup(): () => void {
  const api = window.shelfApi.agent;

  // -------- Inbound: IPC → bus --------
  const offMessage = api.onMessage((tabId, msg) => {
    emitAgent('agent:onMessage', { tabId, msg });
  });
  const offStream = api.onStream((tabId, chunk) => {
    emitAgent('agent:onStream', { tabId, chunk });
  });
  const offStatus = api.onStatus((tabId, status) => {
    emitAgent('agent:onStatus', { tabId, status });
  });
  const offPlan = api.onPlan((tabId, payload) => {
    emitAgent('agent:onPlan', { tabId, content: payload.content });
  });
  const offCapabilities = api.onCapabilities((tabId, caps) => {
    emitAgent('agent:onCapabilities', { tabId, caps });
  });
  const offPermission = api.onPermissionRequest((tabId, req) => {
    emitAgent('agent:onPermissionRequest', { tabId, req });
  });
  const offPicker = api.onPickerRequest((tabId, req) => {
    emitAgent('agent:onPickerRequest', { tabId, req });
  });
  const offAuth = api.onAuthRequired((tabId, provider) => {
    emitAgent('agent:onAuthRequired', { tabId, provider });
  });
  const offInit = api.onInitStatus((tabId, status: AgentInitStatus) => {
    emitAgent('agent:onInitStatus', { tabId, status });
  });

  // -------- Outbound: bus → IPC --------
  const offInitEvt = onAgent('agent:init', ({ tabId, cwd, connection, provider, sessionId, opts }) => {
    api.init(tabId, cwd, connection, provider, sessionId, opts);
  });
  const offSendEvt = onAgent('agent:send', ({ tabId, text, images, prefs }) => {
    api.send(tabId, text, images, prefs);
  });
  const offStopEvt = onAgent('agent:stop', ({ tabId }) => {
    api.stop(tabId);
  });
  const offDestroyEvt = onAgent('agent:destroy', ({ tabId }) => {
    api.destroy(tabId);
  });
  const offResolvePerm = onAgent('agent:resolvePermission', ({ tabId, toolUseId, allow, scope }) => {
    api.resolvePermission(tabId, toolUseId, allow, scope);
  });
  const offResolvePicker = onAgent('agent:resolvePicker', ({ tabId, pickerId, payload }) => {
    api.resolvePicker(tabId, pickerId, payload);
  });
  const offCheckAuth = onAgent('agent:checkAuth', ({ tabId }) => {
    api.checkAuth(tabId);
  });

  return () => {
    offMessage();
    offStream();
    offStatus();
    offPlan();
    offCapabilities();
    offPermission();
    offPicker();
    offAuth();
    offInit();
    offInitEvt();
    offSendEvt();
    offStopEvt();
    offDestroyEvt();
    offResolvePerm();
    offResolvePicker();
    offCheckAuth();
  };
}
