---
type: context
title: External URL Intent
related:
  - architecture/terminal-io
  - contracts/external-url-intent
  - context/keybindings-shell
  - context/terminal-pty
  - context/agent-providers
  - context/project-env
---

# External URL Intent

## external-url-intent#1 — Shelf-controlled external URLs use one main-owned decision gate  ·  [Decision]

**Decision:** Every Shelf-owned request to hand a URL to the operating system first enters one main-owned FIFO gate. The popup shows the exact URL, a parsed destination, a reason, and an immutable source; `Copy URL` is selected by default, followed by `Open with default app` and `Cancel`. Approval is per request and is never remembered.

**Reason:** Automatically opening the default browser makes the Chrome profile unpredictable and hides the destination at the moment of action. Main must own validation, queueing, timeout, clipboard, and default-app effects so renderer and provider paths cannot bypass the same policy.

**Do not change casually because:** Producers must supply either the exact `{projectId, tabId}` captured when the request occurs or an explicit `app-window` source; never substitute the project active when the queued popup is later shown. Only HTTP, HTTPS, and mailto are allowed. Full URLs may contain OAuth state, so diagnostics and persistence may record only validation codes, parsed destinations, and source IDs—not the exact URL or terminal frame payload.

## external-url-intent#2 — Terminal mediation is a cooperative, one-way PTY protocol  ·  [Decision]

**Decision:** Shelf-managed terminals receive a Shelf-required `BROWSER` launcher at spawn. POSIX launchers write one bounded OSC frame to `/dev/tty`; native Windows uses a command wrapper whose PowerShell launcher writes the same frame to `CONOUT$`. PTY main strips the frame before normal observers/rendering, attaches the owning project/tab, validates again, and submits the URL to the common gate. SSH, Docker, and WSL deploy the POSIX launcher into the target user's absolute home with executable-only-owner permissions.

**Reason:** Claude's public login path exposes its OAuth URL only through the terminal program's browser-launcher behavior. A structured PTY frame works across local and remote shells without scraping terminal text, provider-specific parsing, PATH-shadowing system browser commands, or opening a browser on the remote host.

**Do not change casually because:** The launcher is fire-and-forget: after a complete frame is written it exits successfully and never waits for Copy/Open/Cancel. Cancel does not stop the originating CLI. Shelf controls `BROWSER` only at process creation; a user shell profile or later export may replace it and is outside the app boundary. Programs that ignore `BROWSER` and invoke OS browser APIs directly are also outside the boundary. Malformed, oversized, or unterminated frames must be stripped and logged only as bounded anomaly kinds.

### Platform field boundary

- Automated integration covers local POSIX, Docker, and SSH.
- WSL and native Windows/ConPTY use the same implemented contract but require platform field verification. A platform-specific failure follows the issue flow; do not pre-build a second transport without evidence.

## external-url-intent#3 — External URL intent and `browser_open` are separate security contracts  ·  [Decision]

**Decision:** External URL intent means “copy this URL or hand it to the operating system default app.” The agent `browser_open` tool means “open a visible Shelf Web tab that shares Shelf's authenticated web session.” They keep separate request types, prompts, decisions, and side effects.

**Reason:** The destinations carry different identity and permission semantics. Combining them would either send an external OAuth link into Shelf's cookie-bearing Web tab unexpectedly or let an agent request bypass the stricter Web-tab gate.

**Do not change casually because:** Sharing presentation primitives is fine, but never route one contract through the other's approval or persistence model. Neither contract remembers approval.
