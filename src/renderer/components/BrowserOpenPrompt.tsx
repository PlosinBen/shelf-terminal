import { useEffect, useState } from 'react';
import { SelectionPanel } from './SelectionPanel';
import type { BrowserOpenMeta } from '@shared/web-session';

// App-global popup for the browser_open tool (agent asks to open a visible Web
// tab so the user can log in). Sibling of WebPermissionPrompt, but STRICTER:
// only Open / Deny — NO "remember" option and no persisted grant, so a single
// approval can never enable later background opens. Driven by the main-side
// browser-open channel (WEB_BROWSER_OPEN_REQUEST). Requests queue (rare
// concurrency) and show one at a time.

type PendingReq = BrowserOpenMeta & { requestId: string };

export function BrowserOpenPrompt() {
  const [queue, setQueue] = useState<PendingReq[]>([]);

  useEffect(() => {
    const offReq = window.shelfApi.web.onBrowserOpenRequest((req) => {
      setQueue((q) => [...q, req]);
    });
    // Resolved elsewhere (timed out) → drop it locally.
    const offClose = window.shelfApi.web.onBrowserOpenClose((requestId) => {
      setQueue((q) => q.filter((r) => r.requestId !== requestId));
    });
    return () => { offReq(); offClose(); };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const resolve = (decision: 'open' | 'deny') => {
    window.shelfApi.web.resolveBrowserOpen(current.requestId, decision);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="web-perm-overlay">
      <SelectionPanel
        title={<>Let the agent open a <strong>Web tab</strong> for you to log in?</>}
        description={
          <div className="web-perm-desc">
            {/* Authoritatively-parsed origin highlighted; full URL shown muted so
                the user sees the exact page (and a spoofed host can't hide). */}
            <div className="web-perm-origin">
              <strong>{current.origin}</strong>
            </div>
            <div className="web-perm-domain browser-open-url">{current.url}</div>
            <div className="web-perm-note">Opens a visible tab. Nothing loads in the background — you approve each open.</div>
          </div>
        }
        options={[
          { value: 'open', label: 'Open', kind: 'allow' },
          { value: 'deny', label: 'Deny', kind: 'deny' },
        ]}
        onSelect={(value) => resolve(value as 'open' | 'deny')}
      />
    </div>
  );
}
