/** Shelf delegation is independent of provider turns and native background tasks. */
export const DELEGATION = {
  OP: {
    SELECT: 'agent_delegation.select', START: 'agent_delegation.start', SEND: 'agent_delegation.send',
    STATUS: 'agent_delegation.status', PROGRESS: 'agent_delegation.progress', RESULT: 'agent_delegation.result',
  },
  TOOL: {
    SELECT: 'shelf_select_agent', START: 'shelf_start_delegation', SEND: 'shelf_send_delegation',
    STATUS: 'shelf_delegation_status', PROGRESS: 'shelf_report_progress', RESULT: 'shelf_submit_result',
  },
  IPC: {
    CURRENT: 'agent-delegation:current', UPDATE: 'agent-delegation:update', ACTION: 'agent-delegation:action',
    PICKER: 'agent-delegation:picker', RESOLVE: 'agent-delegation:resolve', PICKER_CLOSE: 'agent-delegation:picker-close',
    PREPARE_CLOSE: 'agent-delegation:prepare-close', RENAME: 'agent-delegation:rename',
  },
  EVENT: { ACTION: 'agent-delegation:ui-action', SELECT: 'agent-delegation:ui-select', RENAME: 'agent-delegation:ui-rename' },
  ACTION: { INTERVENE: 'intervene', RESUME: 'resume', EXTRACT: 'extract', STOP: 'stop' },
  DELIVERY: { RECEIVED: 'received', FAILED: 'failed', UNKNOWN: 'unknown' },
  RESULT: { READY: 'ready', EXTRACTING: 'extracting', UNKNOWN: 'unknown' },
  ERROR: {
    MISSING: 'Delegation no longer exists', FORBIDDEN: 'This View is not authorized for this delegation',
    INTERVENING: 'User intervention in progress; send work again after intervention ends',
    OCCUPIED: 'Agent View already has a delegation', RESULT_EXISTS: 'An uncollected result already exists',
    DISCARD: 'Uncollected result will be discarded; confirmation required',
  },
} as const;

export interface AgentViewRef { projectId: string; agentViewId: string }
export interface DelegationView extends AgentViewRef {
  tabId: string; displayName: string; projectName: string; cwd: string; provider: string;
  worktree: boolean; available: boolean;
}
export type DeliveryReceipt = {
  state: typeof DELEGATION.DELIVERY[keyof typeof DELEGATION.DELIVERY]; error?: string;
};
export interface DelegationSnapshot {
  id: string; main: DelegationView; spike: DelegationView; intervening: boolean;
  progress: string; resultState: typeof DELEGATION.RESULT[keyof typeof DELEGATION.RESULT] | null;
  delivery: DeliveryReceipt | null;
}
export interface DelegationPicker {
  requestId: string; caller: DelegationView;
  candidates: Array<{ view: DelegationView; unavailableReason: string | null }>;
}
export interface DelegationUiAction {
  id: string; action: typeof DELEGATION.ACTION[keyof typeof DELEGATION.ACTION]; discard?: boolean;
}
export function sameAgentView(a: AgentViewRef, b: AgentViewRef): boolean {
  return a.projectId === b.projectId && a.agentViewId === b.agentViewId;
}
