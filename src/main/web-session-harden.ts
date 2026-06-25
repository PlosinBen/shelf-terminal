import { app } from 'electron';
import { log } from '@shared/logger';
import { getWebSession } from './web-session';
import { parseHttpOrigin } from './web-session-helpers';

// Hardening for the Web tab. It embeds UNTRUSTED arbitrary web content while
// sharing a partition that holds sensitive corp cookies, so the web content is
// treated as a hostile sandboxed page. All enforcement lives in main (the
// privileged side) — the renderer's <webview> is never trusted to harden itself.

/** Session-level guards on the shared web session (set once at startup). */
export function hardenWebSession(): void {
  const ses = getWebSession();

  // Deny all device/capability permission requests (camera, mic, geolocation,
  // notifications, clipboard-read, …). Open a specific one to an allowlist later
  // only if a real service needs it.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    log.info('web-harden', `denied permission request: ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);

  // Block downloads — a login surface doesn't need them, and silent writes to
  // disk from a hostile page are a risk. (Relax to a controlled flow if needed.)
  ses.on('will-download', (event, item) => {
    log.info('web-harden', `blocked download: ${item.getURL()}`);
    event.preventDefault();
  });
}

/** webContents-level guards, driven by a single global hook (covers every window,
 *  including macOS reactivation). Call once at startup. */
export function installWebviewHardening(): void {
  const blockNonHttp = (event: { preventDefault: () => void }, url: string) => {
    // Browsing is free, but only over http(s): block file:// (local file read),
    // javascript:, and custom-protocol schemes.
    if (!parseHttpOrigin(url)) {
      log.info('web-harden', `blocked navigation to non-http(s): ${url}`);
      event.preventDefault();
    }
  };

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      // Deny popups / new windows (incl. window.open, target=_blank). Popup-based
      // OAuth would need a per-IdP allowlist here; v1 denies all.
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', blockNonHttp);
      contents.on('will-redirect', blockNonHttp);
    } else {
      // Host window: force-safe webPreferences on any <webview> it attaches,
      // regardless of the tag's attributes (defense-in-depth).
      contents.on('will-attach-webview', (_ev, webPreferences) => {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
      });
    }
  });
}
