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
  const addressRef = useRef<HTMLInputElement | null>(null);
  const [address, setAddress] = useState(initialUrl ?? '');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;

    const onNavigate = (e: { url?: string }) => {
      if (!e.url) return;
      setAddress(e.url);
      setWebTabUrl(tabId, e.url);
    };
    // A new navigation starting clears any prior failure banner.
    const onStartLoading = () => setLoadError(null);
    // did-fail-load fires for every blocked subframe too; only surface a
    // main-frame failure, and ignore user/programmatic aborts (errorCode -3).
    const onFailLoad = (e: {
      isMainFrame?: boolean;
      errorCode?: number;
      errorDescription?: string;
      validatedURL?: string;
    }) => {
      if (e.isMainFrame === false) return;
      if (e.errorCode === -3) return;
      const desc = e.errorDescription || 'Failed to load';
      setLoadError(e.validatedURL ? `${desc} — ${e.validatedURL}` : desc);
    };

    el.addEventListener('did-navigate', onNavigate as EventListener);
    el.addEventListener('did-navigate-in-page', onNavigate as EventListener);
    el.addEventListener('did-start-loading', onStartLoading as EventListener);
    el.addEventListener('did-fail-load', onFailLoad as EventListener);
    return () => {
      el.removeEventListener('did-navigate', onNavigate as EventListener);
      el.removeEventListener('did-navigate-in-page', onNavigate as EventListener);
      el.removeEventListener('did-start-loading', onStartLoading as EventListener);
      el.removeEventListener('did-fail-load', onFailLoad as EventListener);
    };
  }, [tabId]);

  // Auto-focus the address bar when a fresh web tab opens (no initial URL),
  // mirroring a browser's new-tab behavior.
  useEffect(() => {
    if (visible && !initialUrl) addressRef.current?.focus();
    // Only on mount — re-focusing on every visibility toggle would steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = () => {
    const url = normalizeUrl(address);
    if (!url) return;
    setLoadError(null);
    addressRef.current?.blur(); // leave the address bar like a browser does on Enter
    webviewRef.current?.loadURL(url).catch(() => { /* invalid URL — webview emits did-fail-load */ });
  };

  return (
    <div className="web-tab" style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', position: 'absolute', inset: 0 }}>
      <div className="web-tab-toolbar">
        <button className="web-tab-nav" title="Back" onClick={() => webviewRef.current?.goBack()}>‹</button>
        <button className="web-tab-nav" title="Forward" onClick={() => webviewRef.current?.goForward()}>›</button>
        <button className="web-tab-nav" title="Reload" onClick={() => webviewRef.current?.reload()}>⟳</button>
        <input
          ref={addressRef}
          className="web-tab-address"
          value={address}
          placeholder="Enter a URL (e.g. kibana.corp.com)"
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
        />
        <span className="web-tab-identity" title="This page loads from your machine, with your logged-in browser identity">
          ⌂ Local · your login
        </span>
      </div>
      {loadError && (
        <div className="web-tab-error" role="alert">{loadError}</div>
      )}
      <webview
        ref={webviewRef as React.Ref<HTMLElement>}
        src={initialUrl || 'about:blank'}
        partition={WEB_SESSION_PARTITION}
        style={{ flex: 1, border: 'none' }}
      />
    </div>
  );
}
