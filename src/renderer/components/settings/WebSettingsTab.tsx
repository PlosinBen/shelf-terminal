import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../store';
import type { WebSessionEntry, WebGrantsByProject } from '@shared/web-session';

// Settings → Web: manage the shared web session.
//   - Logged-in sessions (hygiene): see what you're logged into, log out.
//   - Agent grants (security): per-project origins the agent may call with your
//     session; granted via the permission prompt, revocable here.

export function WebSettingsTab() {
  const { projects } = useStore();
  const [sessions, setSessions] = useState<WebSessionEntry[] | null>(null);
  const [grants, setGrants] = useState<WebGrantsByProject | null>(null);

  const refresh = useCallback(() => {
    window.shelfApi.web.listSessions().then(setSessions).catch(() => setSessions([]));
    window.shelfApi.web.listGrants().then(setGrants).catch(() => setGrants({}));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const nameFor = (projectId: string) =>
    projects.find((p) => p.config.id === projectId)?.config.name ?? projectId;

  const onDeleteSession = async (domain: string) => {
    await window.shelfApi.web.deleteSession(domain);
    refresh();
  };
  const onRevoke = async (projectId: string, origin: string) => {
    await window.shelfApi.web.revokeGrant(projectId, origin);
    refresh();
  };

  const grantEntries = Object.entries(grants ?? {});

  return (
    <div className="web-settings">
      <h3 className="web-settings-title">Logged-in sessions</h3>
      <p className="web-settings-hint">
        Sites you've logged into in Web tabs (one shared session across all projects). Deleting logs you out.
      </p>
      {sessions === null ? (
        <p className="web-settings-hint">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="web-settings-hint">No logged-in sessions.</p>
      ) : (
        <ul className="web-list">
          {sessions.map((s) => (
            <li key={s.domain} className="web-list-item">
              <span className="web-list-main">{s.domain}</span>
              <span className="web-list-sub">{s.cookieCount} cookie{s.cookieCount === 1 ? '' : 's'}</span>
              <button className="web-list-action" onClick={() => onDeleteSession(s.domain)}>Delete</button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="web-settings-title">Agent web access</h3>
      <p className="web-settings-hint">
        Origins each project's agent may call with your logged-in session. Granted via the permission prompt; revoke any here.
      </p>
      {grants === null ? (
        <p className="web-settings-hint">Loading…</p>
      ) : grantEntries.length === 0 ? (
        <p className="web-settings-hint">No grants yet.</p>
      ) : (
        <div className="web-grants">
          {grantEntries.map(([projectId, origins]) => (
            <div key={projectId} className="web-grants-group">
              <div className="web-grants-project">{nameFor(projectId)}</div>
              <ul className="web-list">
                {origins.map((origin) => (
                  <li key={origin} className="web-list-item">
                    <span className="web-list-main">{origin}</span>
                    <button className="web-list-action" onClick={() => onRevoke(projectId, origin)}>Revoke</button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
