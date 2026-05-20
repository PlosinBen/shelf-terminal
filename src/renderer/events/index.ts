// Re-export surface for the renderer event layer. Existing imports of
// `../events` resolve here via the sibling `events.ts` shim, so legacy
// consumers (on / emit / Events) keep working unchanged.
export { on, emit, Events, __resetBusForTests } from './bus';
export { onAgent, emitAgent } from './types';
export type { AgentEventMap, AgentEventName } from './types';
export { bindAgentIPCGroup } from './ipc-agent';
