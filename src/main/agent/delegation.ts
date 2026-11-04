import { AGENT_INPUT_SOURCE, createAgentInputMessage, type AgentInputMessage } from '@shared/agent-input';
import {
  DELEGATION as D, sameAgentView, type AgentViewRef, type DelegationView,
  type DelegationSnapshot, type DeliveryReceipt,
} from '@shared/agent-delegation';

interface ResultSlot { content: string; state: NonNullable<DelegationSnapshot['resultState']> }
interface Entry extends Omit<DelegationSnapshot, 'resultState'> { result: ResultSlot | null }
export interface DelegationDeps {
  views(): DelegationView[];
  deliver(target: DelegationView, message: AgentInputMessage, received: () => void): Promise<DeliveryReceipt>;
  changed(): void;
  mintId(): string;
}

/** Memory only. All mutations and authority checks happen in main, not in UI projections. */
export function createDelegationService(deps: DelegationDeps) {
  const entries = new Map<string, Entry>();
  const selections = new Map<string, AgentViewRef>();
  const key = (view: AgentViewRef) => JSON.stringify([view.projectId, view.agentViewId]);
  const live = (ref: AgentViewRef) => {
    const view = deps.views().find(v => sameAgentView(v, ref));
    if (!view) throw new Error('Agent View is no longer open');
    return view;
  };
  const get = (id: string) => {
    const entry = entries.get(id);
    if (!entry) throw new Error(D.ERROR.MISSING);
    return entry;
  };
  const requireRole = (entry: Entry, caller: AgentViewRef, role?: 'main' | 'spike') => {
    live(caller);
    if (role ? !sameAgentView(entry[role], caller) : !sameAgentView(entry.main, caller) && !sameAgentView(entry.spike, caller)) {
      throw new Error(D.ERROR.FORBIDDEN);
    }
  };
  const incoming = (ref: AgentViewRef) => [...entries.values()].find(e => sameAgentView(e.spike, ref));
  const checkTarget = (caller: AgentViewRef, ref: AgentViewRef) => {
    live(caller);
    const target = live(ref);
    if (sameAgentView(caller, target)) throw new Error('Cannot delegate to this same View');
    if (!target.worktree) throw new Error('Only worktree Project agents can receive delegations');
    if (!target.available) throw new Error('Agent View is not available');
    if (incoming(target)) throw new Error(D.ERROR.OCCUPIED);
    return target;
  };
  const snapshot = (e: Entry): DelegationSnapshot => ({
    id: e.id, main: { ...(deps.views().find(v => sameAgentView(v, e.main)) ?? e.main) },
    spike: { ...(deps.views().find(v => sameAgentView(v, e.spike)) ?? e.spike) }, intervening: e.intervening,
    progress: e.progress, resultState: e.result?.state ?? null, delivery: e.delivery ? { ...e.delivery } : null,
  });
  const text = (value: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Non-empty text is required');
    return value;
  };
  const message = (source: DelegationView, content: string) => {
    const result = createAgentInputMessage({
      source: { kind: AGENT_INPUT_SOURCE.AGENT, agentViewId: source.agentViewId, displayName: source.displayName }, content,
    });
    if (!result.ok) throw new Error(result.error);
    return result.message;
  };
  const send = async (entry: Entry, content: string): Promise<DeliveryReceipt> => {
    const target = live(entry.spike);
    if (!target.available) throw new Error('Agent View is not available');
    if (entry.intervening) throw new Error(D.ERROR.INTERVENING);
    const input = message(live(entry.main),
      `[Shelf delegation ${entry.id}]\nReport progress with ${D.TOOL.PROGRESS} and explicitly submit final text with ${D.TOOL.RESULT}, using this delegationId. `
      + `Result submission does not end this delegation.\n\n${text(content)}`);
    const receipt = await deps.deliver(target, input, () => {
      if (entries.get(entry.id) !== entry) return;
      entry.delivery = { state: D.DELIVERY.RECEIVED }; deps.changed();
    });
    if (entries.get(entry.id) === entry) { entry.delivery = receipt; deps.changed(); }
    return receipt;
  };
  return {
    snapshots: () => [...entries.values()].map(snapshot),
    candidates(caller: AgentViewRef) {
      live(caller);
      return deps.views().filter(v => v.worktree && !sameAgentView(v, caller)).map(view => ({
        view, unavailableReason: incoming(view) ? D.ERROR.OCCUPIED : !view.available ? 'Agent View is not available' : null,
      }));
    },
    select(caller: AgentViewRef, target: AgentViewRef) {
      const view = checkTarget(caller, target);
      selections.set(key(caller), { projectId: view.projectId, agentViewId: view.agentViewId });
      return view;
    },
    async start(caller: AgentViewRef, target: AgentViewRef, content: string) {
      text(content);
      const selected = selections.get(key(caller));
      if (!selected || !sameAgentView(selected, target)) throw new Error('Select this target in the Shelf picker first');
      const spike = checkTarget(caller, target);
      const entry: Entry = { id: deps.mintId(), main: live(caller), spike, intervening: false, progress: '', result: null, delivery: null };
      selections.delete(key(caller)); entries.set(entry.id, entry); deps.changed();
      return { delegationId: entry.id, delivery: await send(entry, content) };
    },
    async send(caller: AgentViewRef, id: string, content: string) {
      const entry = get(id); requireRole(entry, caller, 'main');
      return send(entry, content);
    },
    status(caller: AgentViewRef, id?: string) {
      const relevant = id ? [get(id)] : [...entries.values()].filter(e => sameAgentView(e.main, caller) || sameAgentView(e.spike, caller));
      live(caller);
      return relevant.map(e => {
        requireRole(e, caller);
        return { delegationId: e.id, intervening: e.intervening, hasResult: !!e.result,
          resultState: e.result?.state ?? null, available: deps.views().find(v => sameAgentView(v, e.spike))?.available ?? false,
          delivery: e.delivery ? { ...e.delivery } : null };
      });
    },
    progress(caller: AgentViewRef, id: string, content: string) {
      const entry = get(id); requireRole(entry, caller, 'spike');
      entry.progress = text(content); deps.changed();
    },
    submit(caller: AgentViewRef, id: string, content: string) {
      const entry = get(id); requireRole(entry, caller, 'spike');
      if (entry.result) throw new Error(D.ERROR.RESULT_EXISTS);
      entry.result = { content: text(content), state: D.RESULT.READY }; deps.changed();
    },
    intervene(id: string, enabled: boolean) {
      const entry = get(id); const spike = live(entry.spike);
      entry.intervening = enabled; deps.changed(); return { ...spike };
    },
    assertUserInput(tabId: string) {
      const entry = [...entries.values()].find(e => e.spike.tabId === tabId);
      if (entry && !entry.intervening) throw new Error('This View has a delegation; use Intervene before sending user input');
    },
    async extract(id: string) {
      const entry = get(id);
      const slot = entry.result;
      if (!slot || slot.state !== D.RESULT.READY) throw new Error('No result is ready for extraction');
      const main = live(entry.main);
      if (!main.available) throw new Error('Main Agent View is not available');
      const input = message(live(entry.spike), `[Shelf delegation ${entry.id} result]\n\n${slot.content}`);
      slot.state = D.RESULT.EXTRACTING; deps.changed();
      const received = () => {
        if (entries.get(id) === entry && entry.result === slot) { entry.result = null; deps.changed(); }
      };
      let receipt: DeliveryReceipt;
      try { receipt = await deps.deliver(main, input, received); }
      catch (error) { receipt = { state: D.DELIVERY.UNKNOWN, error: String(error) }; }
      if (receipt.state === D.DELIVERY.RECEIVED) received();
      else if (entries.get(id) === entry && entry.result === slot) {
        slot.state = receipt.state === D.DELIVERY.FAILED ? D.RESULT.READY : D.RESULT.UNKNOWN; deps.changed();
      }
      return receipt;
    },
    stop(id: string, discard = false) {
      const entry = get(id);
      if (entry.result && !discard) throw new Error(D.ERROR.DISCARD);
      entries.delete(id); deps.changed();
    },
    prepareClose(tabIds: string[], discard = false) {
      const affected = [...entries.values()].filter(e => tabIds.includes(e.main.tabId) || tabIds.includes(e.spike.tabId));
      if (!discard && affected.some(e => e.result)) return false;
      for (const entry of affected) entries.delete(entry.id);
      const removed = deps.views().filter(v => tabIds.includes(v.tabId));
      for (const [caller, target] of selections) {
        if (removed.some(v => key(v) === caller || sameAgentView(v, target))) selections.delete(caller);
      }
      if (affected.length) deps.changed();
      return true;
    },
  };
}
export type DelegationService = ReturnType<typeof createDelegationService>;
