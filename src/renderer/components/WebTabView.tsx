import { useEffect, useRef, useState } from 'react';
import { WEB_SESSION_PARTITION } from '@shared/web-session';
import { setWebTabUrl } from '../store';

// Web tab: a hardened <webview> that doubles as the login surface for the shared
// web session. The user logs into Kibana / ArgoCD here; cookies land in the
// `persist:web` partition (owned by main) and the agent's web.fetch rides them.
//
// Hardening: scoped partition, no nodeintegration (default off for <webview>),
// popups disabled. Web content runs isolated in its own process.

interface WebviewEl extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

interface Props {
  tabId: string;
  initialUrl?: string;
  visible: boolean;
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function WebTabView({ tabId, initialUrl, visible }: Props) {
  const webviewRef = useRef<WebviewEl | null>(null);
  const [address, setAddress] = useState(initialUrl ?? '');

  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;

    const onNavigate = (e: { url?: string }) => {
      if (!e.url) return;
      setAddress(e.url);
      setWebTabUrl(tabId, e.url);
    };

    el.addEventListener('did-navigate', onNavigate as EventListener);
    el.addEventListener('did-navigate-in-page', onNavigate as EventListener);
    return () => {
      el.removeEventListener('did-navigate', onNavigate as EventListener);
      el.removeEventListener('did-navigate-in-page', onNavigate as EventListener);
    };
  }, [tabId]);

  const go = () => {
    const url = normalizeUrl(address);
    if (!url) return;
    webviewRef.current?.loadURL(url).catch(() => { /* invalid URL — webview emits did-fail-load */ });
  };

  return (
    <div className="web-tab" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
      <div className="web-tab-toolbar">
        <button className="web-tab-nav" title="Back" onClick={() => webviewRef.current?.goBack()}>‹</button>
        <button className="web-tab-nav" title="Forward" onClick={() => webviewRef.current?.goForward()}>›</button>
        <button className="web-tab-nav" title="Reload" onClick={() => webviewRef.current?.reload()}>⟳</button>
        <input
          className="web-tab-address"
          value={address}
          placeholder="Enter a URL (e.g. kibana.corp.com)"
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
        />
        <span className="web-tab-identity" title="This page loads from your machine, with your logged-in browser identity">
          ⌂ Local · your login
        </span>
      </div>
      <webview
        ref={webviewRef as React.Ref<HTMLElement>}
        src={initialUrl || 'about:blank'}
        partition={WEB_SESSION_PARTITION}
        style={{ flex: 1, border: 'none' }}
      />
    </div>
  );
}
