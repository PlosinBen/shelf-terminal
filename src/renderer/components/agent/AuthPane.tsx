import React from 'react';
import {
  setAuthBusy,
  setAuthError,
  setAuthRequired,
  useAgentTab,
} from '../../agentTabStore';

interface Props {
  tabId: string;
}

/**
 * Full-pane replacement for the chat UI when the provider reports
 * authentication is missing. Shows method-specific instructions
 * (api-key / oauth / sdk-managed) and a Retry button that calls
 * checkAuth (kept as direct IPC — checkAuth returns Promise<boolean>
 * which the event-bus pattern can't carry).
 *
 * Caller (AgentView) renders this *instead of* the chat area when
 * tab.authRequired is set; on Retry success the store clears
 * authRequired and the normal chat UI renders again.
 */
export function AuthPane({ tabId }: Props) {
  const tab = useAgentTab(tabId);
  const authRequired = tab?.authRequired ?? null;
  const authBusy = tab?.authBusy ?? false;
  const authError = tab?.authError ?? null;
  const authMethod = tab?.capabilities?.authMethod;

  if (!authRequired) return null;

  const providerLabel = authRequired.provider.charAt(0).toUpperCase() + authRequired.provider.slice(1);

  const retry = async () => {
    setAuthBusy(tabId, true);
    setAuthError(tabId, null);
    // checkAuth is a query (returns Promise<boolean>), not a notify —
    // direct IPC keeps the return value. Going through emit would
    // need an inbound 'agent:onAuthChecked' event, not worth the
    // plumbing for a one-shot UI affordance.
    const result = await window.shelfApi.agent.checkAuth(tabId);
    if (result) {
      setAuthRequired(tabId, null);
      setAuthError(tabId, null);
    } else {
      setAuthError(tabId, 'Still no valid credentials found.');
    }
    setAuthBusy(tabId, false);
  };

  return (
    <div className="agent-auth-pane">
      <div className="agent-auth-title">
        {authMethod?.kind === 'api-key' ? `${providerLabel} API key missing` :
         authMethod?.kind === 'sdk-managed' ? `${providerLabel} SDK not signed in` :
         `${providerLabel} not authenticated`}
      </div>
      {authMethod?.kind === 'api-key' && (
        <div className="agent-auth-instructions">
          {providerLabel} needs an API key.
          {authMethod.setupUrl && <> Get one at <code>{authMethod.setupUrl}</code>.</>}
        </div>
      )}
      {(authMethod?.kind === 'sdk-managed' || authMethod?.kind === 'oauth') && (
        <>
          <div className="agent-auth-instructions">Run the following, then click Retry:</div>
          <ul className="agent-auth-list">
            {authMethod.instructions.map((ins, i) => (
              <li key={i}>{ins.command && <code>{ins.command}</code>}{ins.label && ` — ${ins.label}`}</li>
            ))}
          </ul>
        </>
      )}
      <button className="agent-reset-btn" disabled={authBusy} onClick={retry}>
        {authBusy ? 'Checking…' : 'Retry'}
      </button>
      {authError && <div className="agent-auth-error">{authError}</div>}
    </div>
  );
}
