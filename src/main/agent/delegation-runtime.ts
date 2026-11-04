import { DELEGATION as D, type AgentViewRef, type DelegationPicker, type DelegationView } from '@shared/agent-delegation';
import type { DelegationService } from './delegation';
import type { AppToolContext } from './app-tool';

/** Configured by the Agent manager. No circular import back into its session map. */
let runtime: {
  service: DelegationService;
  caller(ctx: AppToolContext): DelegationView;
  picker(request: DelegationPicker | { requestId: string }): boolean;
} | null = null;
const pending = new Map<string, { caller: DelegationView; resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
export function configureDelegationRuntime(value: NonNullable<typeof runtime>): void { runtime = value; }
export function requireDelegationRuntime() {
  if (!runtime) throw new Error('Delegation service is not initialized');
  return runtime;
}
export async function selectDelegationTarget(ctx: AppToolContext) {
  const r = requireDelegationRuntime(); const caller = r.caller(ctx);
  if ([...pending.values()].some(p => p.caller.tabId === caller.tabId)) throw new Error('A target selection is already pending');
  const candidates = r.service.candidates(caller);
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => resolveDelegationTarget(requestId, null), 5 * 60_000); timer.unref?.();
    pending.set(requestId, { caller, resolve, timer });
    if (!r.picker({ requestId, caller, candidates })) resolveDelegationTarget(requestId, null);
  });
}
export function resolveDelegationTarget(requestId: string, target: AgentViewRef | null) {
  const p = pending.get(requestId);
  if (!p) throw new Error(`Target selection is no longer pending: ${requestId}`);
  pending.delete(requestId); clearTimeout(p.timer);
  const r = requireDelegationRuntime(); r.picker({ requestId });
  if (!target) { p.resolve({ cancelled: true }); return; }
  try {
    const selected = r.service.select(p.caller, target);
    p.resolve({ cancelled: false, target: { projectId: selected.projectId, agentViewId: selected.agentViewId,
      displayName: selected.displayName, projectName: selected.projectName } });
  }
  catch (error) { p.resolve({ cancelled: true, error: String(error) }); }
}
export function cancelDelegationPickers(tabIds: string[]) {
  for (const [id, request] of pending) if (tabIds.includes(request.caller.tabId)) resolveDelegationTarget(id, null);
}
export function isDelegationOperation(op: string): boolean {
  return (Object.values(D.OP) as string[]).includes(op);
}
