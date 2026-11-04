import type { AgentInitStatus } from '../../shared/types';
import { onAgent, emitAgent } from './types';
import { SHELF_MCP } from '../../shared/shelf-mcp';
import { cancelPendingSend } from '../agentTabStore';
import { isSubmissionUncertain, SUBMISSION_ERROR as E, type SubmissionError } from '../../shared/agent-submission';

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
  const offShelfMcp = api.onShelfMcpStatus((tabId, status) => {
    emitAgent(SHELF_MCP.STATUS_EVENT, { tabId, status });
  });

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
  const offBackgroundTasks = api.onBackgroundTasks((tabId, event) => {
    emitAgent('agent:onBackgroundTasks', { tabId, event });
  });
  const offQueue = api.onQueue((tabId, items) => {
    emitAgent('agent:onQueue', { tabId, items });
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
  const offLoginPrompt = api.onLoginPrompt((tabId, prompt) => {
    emitAgent('agent:onLoginPrompt', { tabId, prompt });
  });
  const offLoginDone = api.onLoginDone((tabId, result) => {
    emitAgent('agent:onLoginDone', { tabId, result });
  });

  // -------- Outbound: bus → IPC --------
  const offInitEvt = onAgent('agent:init', ({ tabId, cwd, connection, provider, sessionId, opts }) => {
    api.init(tabId, cwd, connection, provider, sessionId, opts);
  });
  const offSendEvt = onAgent('agent:send', ({ tabId, ...input }) => {
    const failed = (error: SubmissionError) => {
      console.error('Agent input submission failed', { tabId, msgId: input.inputMessage?.msgId, error });
      if (input.inputMessage && !isSubmissionUncertain(error) && error.code !== E.DUPLICATE) cancelPendingSend(tabId, input.inputMessage.msgId);
      emitAgent('agent:onMessage', { tabId, msg: { type: 'error', content: `Input submission failed (${error.code}): ${error.message}` } });
    };
    void Promise.resolve(api.send(tabId, input)).then(result => {
      if (result === false) failed({ code: E.NOT_SENT, message: 'Target Agent View is not available' });
      else if (typeof result === 'object' && !result.ok) failed(result.error);
    }).catch(error => {
      failed({ code: E.UNCONFIRMED, message: `Could not confirm submission: ${String(error)}. Do not automatically resend.` });
    });
  });
  const offStopEvt = onAgent('agent:stop', ({ tabId }) => {
    api.stop(tabId);
  });
  const offCancelQueuedEvt = onAgent('agent:cancelQueued', ({ tabId, clientMsgId }) => {
    api.cancelQueued(tabId, clientMsgId);
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

  return () => {
    offShelfMcp();
    offMessage();
    offStream();
    offStatus();
    offPlan();
    offBackgroundTasks();
    offQueue();
    offCapabilities();
    offPermission();
    offPicker();
    offAuth();
    offInit();
    offLoginPrompt();
    offLoginDone();
    offInitEvt();
    offSendEvt();
    offStopEvt();
    offCancelQueuedEvt();
    offDestroyEvt();
    offResolvePerm();
    offResolvePicker();
  };
}
