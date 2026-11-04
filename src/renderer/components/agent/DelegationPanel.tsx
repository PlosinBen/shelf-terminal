import { DELEGATION as D } from '@shared/agent-delegation';
import { emitAgent } from '../../events';
import { useDelegations } from '../../delegationStore';

export function DelegationPanel({ tabId }: { tabId: string }) {
  const { entries, busy, error } = useDelegations();
  const relevant = entries.filter(e => e.main.tabId === tabId || e.spike.tabId === tabId);
  if (!relevant.length && !error) return null;
  return <div className="delegation-panel" data-testid="delegation-panel">
    {error && <div className="delegation-error" role="status">{error}</div>}
    {relevant.map(entry => {
      const recipient = entry.spike.tabId === tabId;
      const peer = recipient ? entry.main : entry.spike;
      const act = (action: typeof D.ACTION[keyof typeof D.ACTION]) => emitAgent(D.EVENT.ACTION, { id: entry.id, action });
      return <section className={`delegation-card ${recipient ? 'delegation-incoming' : 'delegation-outgoing'}`} key={entry.id} data-delegation-id={entry.id}>
        <div className="delegation-heading"><span aria-hidden="true">{recipient ? '↙' : '↗'}</span> {recipient ? 'Incoming delegation' : 'Outgoing delegation'}</div>
        <div className="delegation-peer"><span>{recipient ? 'From' : 'To'}:</span> <strong>{peer.projectName} / {peer.displayName}</strong></div>
        <div className="delegation-status">
          {entry.intervening ? 'User intervention' : 'Delegation active'}
          {entry.resultState && <span> · {entry.resultState === D.RESULT.READY ? 'Result ready' : entry.resultState === D.RESULT.EXTRACTING ? 'Collecting result…' : 'Delivery unconfirmed'}</span>}
          {entry.delivery?.state === D.DELIVERY.UNKNOWN && <span> · Work delivery unconfirmed</span>}
          {entry.delivery?.state === D.DELIVERY.FAILED && <span> · Work delivery failed</span>}
        </div>
        {entry.progress && <div className="delegation-progress">{entry.progress}</div>}
        <div className="delegation-actions">
          <button className="delegation-button" disabled={busy.includes(entry.id)} onClick={() => act(entry.intervening ? D.ACTION.RESUME : D.ACTION.INTERVENE)}>{entry.intervening ? 'End intervention' : 'Intervene'}</button>
          {!recipient && <button className="delegation-button delegation-collect" disabled={busy.includes(entry.id) || entry.resultState !== D.RESULT.READY} onClick={() => act(D.ACTION.EXTRACT)}>Collect result</button>}
          <button className="delegation-button delegation-stop" disabled={busy.includes(entry.id)} onClick={() => act(D.ACTION.STOP)}>Stop delegation</button>
        </div>
      </section>;
    })}
  </div>;
}

export function DelegationTargetPicker() {
  const request = useDelegations().pickers[0];
  if (!request) return null;
  const choose = (target: typeof request.caller | null) => emitAgent(D.EVENT.SELECT, { requestId: request.requestId, target });
  return <div className="web-perm-overlay"><div className="delegation-picker" role="dialog" aria-modal="true" aria-label="Select delegated Agent">
    <div className="settings-header">Select worktree Agent</div>
    <div className="delegation-picker-body">
      <div className="delegation-requester">
        <div className="delegation-picker-label">Requested by</div>
        <strong>{request.caller.projectName} / {request.caller.displayName}</strong>
      </div>
      <p className="delegation-picker-note">Selecting an Agent authorizes this main View to delegate work to it until the delegation is stopped.</p>
      <div className="delegation-picker-label">Available worktree Agents</div>
      <div className="delegation-targets">
        {request.candidates.length === 0 && <p className="delegation-picker-empty">No worktree Agent Views are open.</p>}
        {request.candidates.map(({ view, unavailableReason }) => <button className="delegation-target" key={view.tabId} disabled={!!unavailableReason} onClick={() => choose(view)}>
          <span className="delegation-target-heading"><strong>{view.projectName} / {view.displayName}</strong><span className="delegation-provider">{view.provider}</span></span>
          <span className="delegation-target-path">{view.cwd}</span>
          {unavailableReason && <span className="delegation-target-reason">{unavailableReason}</span>}
        </button>)}
      </div>
    </div>
    <div className="project-edit-footer"><button className="conn-btn conn-btn-cancel" onClick={() => choose(null)}>Cancel</button></div>
  </div></div>;
}
