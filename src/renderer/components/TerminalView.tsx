import React, { useRef, useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useStore, markUnread } from '../store';
import { getTheme } from '../themes';
import { useAttachmentPaste } from '../hooks/useAttachmentPaste';
import '@xterm/xterm/css/xterm.css';

import type { Connection } from '@shared/types';

interface Props {
  tabId: string;
  projectId: string;
  cwd: string;
  connection: Connection;
  initScript?: string;
  tabCmd?: string;
  visible: boolean;
}

// Cache xterm instances so they survive re-renders and remounts
const terminalCache = new Map<string, { term: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon; opened: boolean }>();

// Expose the cache to E2E tests — the WebGL renderer paints to canvas so
// `.xterm-rows` is empty in the DOM; tests read the xterm buffer directly
// through this hook instead.
if (typeof window !== 'undefined') {
  (window as unknown as { __shelfTerminalCache__?: typeof terminalCache }).__shelfTerminalCache__ = terminalCache;
}

// POSIX single-quote escape — works for nearly all POSIX shells.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function getSearchAddon(tabId: string): SearchAddon | null {
  return terminalCache.get(tabId)?.searchAddon ?? null;
}

function loadWebgl(term: Terminal) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      setTimeout(() => loadWebgl(term), 100);
    });
    term.loadAddon(webgl);
  } catch {
    // WebGL2 not available — DOM renderer is fine
  }
}

export function TerminalView({ tabId, projectId, cwd, connection, initScript, tabCmd, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [initLoading, setInitLoading] = useState(!!(initScript || tabCmd));
  const { settings, layoutGeneration } = useStore();
  const theme = getTheme(settings.themeName);

  useAttachmentPaste(containerRef, {
    connection,
    cwd,
    maxUploadSizeMB: settings.maxUploadSizeMB,
    onUpload: (uploads) => {
      if (uploads.length === 0) return;
      const paths = uploads.map((u) => shellQuote(u.displayPath));
      window.shelfApi.pty.input(tabId, paths.join(' '));
    },
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || initializedRef.current) return;
    initializedRef.current = true;

    let cached = terminalCache.get(tabId);
    if (!cached) {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        scrollback: settings.scrollback,
        theme: theme.terminal,
        allowProposedApi: true,
        ...(navigator.platform.includes('Win') ? { windowsMode: true } as any : {}),
      });
      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      const unicode11Addon = new Unicode11Addon();
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(unicode11Addon);
      if (settings.unicode11) term.unicode.activeVersion = '11';
      term.loadAddon(new WebLinksAddon());
      cached = { term, fitAddon, searchAddon, opened: false };
      terminalCache.set(tabId, cached);
    }

    const { term, fitAddon } = cached;

    if (cached.opened) {
      if (term.element) {
        container.appendChild(term.element);
      }
      loadWebgl(term);
    } else {
      cached.opened = true;
      term.open(container);
      loadWebgl(term);
    }

    // Windows/Linux: let browser handle Ctrl+V (paste) and Ctrl+C (copy when selected)
    // App keybindings are already intercepted at capture phase by useKeybindings
    if (!navigator.platform.toUpperCase().includes('MAC')) {
      term.attachCustomKeyEventHandler((e) => {
        if (e.ctrlKey && e.key === 'v') return false;
        if (e.ctrlKey && e.key === 'c' && term.hasSelection()) return false;
        return true;
      });
    }

    // Fit after open
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Spawn pty
    window.shelfApi.pty.spawn(projectId, tabId, cwd, connection, initScript, tabCmd);

    // Terminal input → pty
    const onDataDispose = term.onData((data) => {
      window.shelfApi.pty.input(tabId, data);
    });

    // Pty output → terminal
    const removeDataListener = window.shelfApi.pty.onData((id, data) => {
      if (id === tabId) {
        term.write(data);
        if (!visibleRef.current) markUnread(tabId);
      }
    });

    // Init script sent → hide loading
    const removeInitSentListener = window.shelfApi.pty.onInitSent((id) => {
      if (id === tabId) setInitLoading(false);
    });

    // Resize handling
    const onResizeDispose = term.onResize(({ cols, rows }) => {
      window.shelfApi.pty.resize(tabId, cols, rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (visible) {
        fitAddon.fit();
      }
    });
    resizeObserver.observe(container);

    return () => {
      onDataDispose.dispose();
      onResizeDispose.dispose();
      removeDataListener();
      removeInitSentListener();
      resizeObserver.disconnect();
    };
  }, [tabId]);

  // Apply settings changes to existing terminals
  useEffect(() => {
    const cached = terminalCache.get(tabId);
    if (cached) {
      cached.term.options.theme = theme.terminal;
      cached.term.options.fontSize = settings.fontSize;
      cached.term.options.fontFamily = settings.fontFamily;
      cached.term.options.scrollback = settings.scrollback;
      cached.term.unicode.activeVersion = settings.unicode11 ? '11' : '6';
      requestAnimationFrame(() => cached.fitAddon.fit());
    }
  }, [settings.themeName, settings.fontSize, settings.fontFamily, settings.scrollback, settings.unicode11, tabId]);

  // Re-fit when visibility changes (double rAF to ensure DOM layout is complete)
  useEffect(() => {
    if (visible) {
      const cached = terminalCache.get(tabId);
      if (cached) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            cached.fitAddon.fit();
            cached.term.refresh(0, cached.term.rows - 1);
            cached.term.focus();
          });
        });
      }
    }
  }, [visible, tabId, layoutGeneration]);

  return (
    <>
      <div
        ref={containerRef}
        className="terminal-container"
        style={{ display: visible ? 'block' : 'none' }}
      />
      {initLoading && visible && (
        <div className="terminal-loading">Loading...</div>
      )}
    </>
  );
}

// Cleanup when tab is removed
export function disposeTerminal(tabId: string) {
  const cached = terminalCache.get(tabId);
  if (cached) {
    cached.searchAddon.dispose();
    cached.fitAddon.dispose();
    cached.term.dispose();
    terminalCache.delete(tabId);
  }
}
