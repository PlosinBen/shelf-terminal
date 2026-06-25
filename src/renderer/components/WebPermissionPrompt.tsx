import { useEffect, useState } from 'react';
import { SelectionPanel } from './SelectionPanel';
import type { WebPermissionMeta } from '@shared/web-session';

// App-global popup for web.fetch authorization. Driven by the main-side
// web-permission channel (WEB_PERMISSION_REQUEST), NOT the agent tool-permission
// path — so it's provider-agnostic and the agent timeline never branches on
// tool semantics. Requests queue (rare concurrency) and are shown one at a time.

type PendingReq = WebPermissionMeta & { requestId: string };

export function WebPermissionPrompt() {
  const [queue, setQueue] = useState<PendingReq[]>([]);

  useEffect(() => {
    const offReq = window.shelfApi.web.onPermissionRequest((req) => {
      setQueue((q) => [...q, req]);
    });
    // Resolved elsewhere (Telegram while Away, or timed out) → drop it locally.
    const offClose = window.shelfApi.web.onPermissionClose((requestId) => {
      setQueue((q) => q.filter((r) => r.requestId !== requestId));
    });
    return () => { offReq(); offClose(); };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const resolve = (decision: 'once' | 'always' | 'deny') => {
    window.shelfApi.web.resolvePermission(current.requestId, decision);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="web-perm-overlay">
      <SelectionPanel
        title={<>Let the agent use <strong>your logged-in browser session</strong>?</>}
        description={
          <div className="web-perm-desc">
            {/* Authoritatively-parsed origin — never the agent's raw URL string,
                so a spoofed host (userinfo / IDN / subdomain) can't sneak past. */}
            <div className="web-perm-origin">
              {current.method} <strong>{current.origin}</strong>
            </div>
            {current.registrableDomain && (
              <div className="web-perm-domain">domain: {current.registrableDomain}</div>
            )}
            <div className="web-perm-note">Sends requests with your identity at this origin (reads and writes).</div>
          </div>
        }
        options={[
          { value: 'once',   label: 'Allow once',               kind: 'allow' },
          { value: 'always', label: 'Always allow this origin', kind: 'allow' },
          { value: 'deny',   label: 'Deny',                     kind: 'deny'  },
        ]}
        onSelect={(value) => resolve(value as 'once' | 'always' | 'deny')}
      />
    </div>
  );
}
