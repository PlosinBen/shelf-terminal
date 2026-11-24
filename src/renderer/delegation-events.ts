import { DELEGATION as D, type DelegationView } from '@shared/agent-delegation';
import { onAgent } from './events';
import { getProjectById, getProjectIndexById, setActiveProjectById, setActiveTab } from './store';
import {
  getDelegations, setDelegations, enqueueDelegationPicker, removeDelegationPicker,
  setDelegationBusy, setDelegationError, notifyDelegationEnded,
} from './delegationStore';

/** Called by App's central coordinator, never from a UI trigger. */
export function bindDelegationEvents() {
  const api = window.shelfApi.delegation;
  let changed = false, active = true;
  const offUpdate = api.onUpdate(value => {
    changed = true;
    const removed = getDelegations().entries.filter(old => !value.some(entry => entry.id === old.id));
    for (const entry of removed) {
      if (!getDelegations().busy.includes(entry.id)) notifyDelegationEnded(entry);
    }
    if (value.some(entry => !getDelegations().entries.some(old => old.id === entry.id))) setDelegationError(null);
    setDelegations(value);
  });
  const offPicker = api.onPicker(enqueueDelegationPicker);
  const offClose = api.onPickerClose(({ requestId }) => removeDelegationPicker(requestId));
  void api.current().then(value => { if (active && !changed) setDelegations(value); }).catch(report);
  const offSelect = onAgent(D.EVENT.SELECT, payload => {
    setDelegationError(null);
    void api.resolve(payload.requestId, payload.target).then(result => {
      if (!result.ok) throw new Error(result.error);
      removeDelegationPicker(payload.requestId);
    }).catch(report);
  });
  const offAction = onAgent(D.EVENT.ACTION, payload => {
    if (getDelegations().busy.includes(payload.id)) return;
    setDelegationError(null);
    setDelegationBusy(payload.id, true);
    void (async () => {
      try {
        const entry = getDelegations().entries.find(e => e.id === payload.id);
        if (!entry) throw new Error(D.ERROR.MISSING);
        let discard = false;
        if (payload.action === D.ACTION.STOP && entry.resultState) {
          discard = await window.shelfApi.dialog.confirm('Stop delegation?', 'This delegation has an uncollected result. Stopping will discard it.', 'Stop and discard');
          if (!discard) return;
        }
        const result = await api.action({ ...payload, discard });
        if (!result.ok) throw new Error(result.error);
        if (payload.action === D.ACTION.INTERVENE) focusView(result.data as DelegationView);
        const data = result.data as { state?: string; error?: string } | undefined;
        if (payload.action === D.ACTION.EXTRACT && data?.state !== D.DELIVERY.RECEIVED) throw new Error(data?.error ?? 'Result delivery is not confirmed; no automatic resend');
      } catch (error) { report(error); }
      finally { setDelegationBusy(payload.id, false); }
    })();
  });
  const offRename = onAgent(D.EVENT.RENAME, ({ tabId, displayName }) => { void api.rename(tabId, displayName).catch(report); });
  return () => { active = false; offUpdate(); offPicker(); offClose(); offSelect(); offAction(); offRename(); };
}
function report(error: unknown) {
  console.error('[delegation]', error); setDelegationError(String(error));
}
function focusView(view: DelegationView) {
  const project = getProjectById(view.projectId);
  const index = project?.tabs.findIndex(tab => tab.id === view.tabId) ?? -1;
  if (index < 0) throw new Error('Delegated View is no longer open');
  setActiveProjectById(view.projectId); setActiveTab(getProjectIndexById(view.projectId), index);
}
export async function prepareDelegationClose(tabIds: string[]): Promise<boolean> {
  if (!tabIds.length) return true;
  try {
    const api = window.shelfApi.delegation;
    if (await api.prepareClose(tabIds)) return true;
    const discard = await window.shelfApi.dialog.confirm('Close Agent View?', 'A delegation has an uncollected result. Closing will end the delegation and discard the result.', 'Close and discard');
    return discard ? await api.prepareClose(tabIds, true) : false;
  } catch (error) { report(error); return false; }
}
