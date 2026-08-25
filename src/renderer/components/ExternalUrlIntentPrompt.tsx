import { SelectionPanel } from './SelectionPanel';
import { emit, Events } from '../events';
import { useStore } from '../store';
import type { ExternalUrlIntentDecision } from '@shared/external-url-intent';

export function ExternalUrlIntentPrompt() {
  const { externalUrlIntents } = useStore();
  const current = externalUrlIntents[0];
  if (!current) return null;

  const decide = (decision: ExternalUrlIntentDecision) => {
    emit(Events.EXTERNAL_URL_INTENT_DECIDE, current.requestId, decision);
  };
  const destination = current.destination.kind === 'web-origin'
    ? current.destination.origin
    : current.destination.address;

  return (
    <div className={`web-perm-overlay external-url-intent-overlay${current.resolving ? ' is-resolving' : ''}`}>
      <SelectionPanel
        key={current.requestId}
        title="External link requested"
        description={
          <div className="web-perm-desc external-url-intent-desc">
            <div className="project-requester external-url-intent-source">
              Requested by: {current.sourceLabel}
            </div>
            <div className="external-url-intent-reason">{current.reason}</div>
            <div className="web-perm-origin external-url-intent-destination">
              <strong>{destination}</strong>
            </div>
            <div className="web-perm-domain external-url-intent-url">{current.url}</div>
            <div className="web-perm-note">
              Copying keeps the URL in Shelf. Opening hands it to your operating system's default app.
            </div>
            {current.error && <div className="external-url-intent-error">{current.error}</div>}
          </div>
        }
        options={[
          { value: 'copy', label: 'Copy URL', kind: 'allow' },
          { value: 'open', label: 'Open with default app', kind: 'allow' },
          { value: 'cancel', label: 'Cancel', kind: 'deny' },
        ]}
        cancellable
        initialSelected={0}
        onSelect={(value) => decide(value as ExternalUrlIntentDecision)}
        onCancel={() => decide('cancel')}
      />
    </div>
  );
}
