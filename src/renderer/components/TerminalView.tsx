import React, { useRef, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { useStore, markUnread } from '../store';
import { getTheme } from '../themes';
import '@xterm/xterm/css/xterm.css';

import type { Connection } from '../../shared/types';

interface Props {
  tabId: string;
  projectId: string;
  cwd: string;
  connection: Connection;
  initScript?: string;
  visible: boolean;
}

// Cache xterm instances so they survive re-renders
const terminalCache = new Map<string, { term: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon }>();

export function getSearchAddon(tabId: string): SearchAddon | null {
  return terminalCache.get(tabId)?.searchAddon ?? null;
}

export function TerminalView({ tabId, projectId, cwd, connection, initScript, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const { settings } = useStore();
  const theme = getTheme(settings.themeName);

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
        windowsMode: navigator.platform.includes('Win'),
      });
      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      cached = { term, fitAddon, searchAddon };
      terminalCache.set(tabId, cached);
    }

    const { term, fitAddon } = cached;
    term.open(container);

    // Fit after open
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Spawn pty
    window.shelfApi.pty.spawn(projectId, tabId, cwd, connection, initScript);

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

    // Image paste: intercept only when clipboard has image but no text
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      // If there's text content, let xterm handle normal text paste
      const hasText = Array.from(items).some((item) => item.type === 'text/plain');
      if (hasText) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          const buffer = await blob.arrayBuffer();

          if (connection.type === 'ssh') {
            // Save locally first, then SCP to remote
            const remotePath = await window.shelfApi.clipboard.saveImageRemote(
              buffer,
              connection.host,
              connection.port,
              connection.user,
            );
            window.shelfApi.pty.input(tabId, remotePath);
          } else {
            const filePath = await window.shelfApi.clipboard.saveImage(buffer);
            window.shelfApi.pty.input(tabId, filePath);
          }
          return;
        }
      }
    };
    container.addEventListener('paste', handlePaste);

    return () => {
      onDataDispose.dispose();
      onResizeDispose.dispose();
      removeDataListener();
      resizeObserver.disconnect();
      container.removeEventListener('paste', handlePaste);
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
      requestAnimationFrame(() => cached.fitAddon.fit());
    }
  }, [settings.themeName, settings.fontSize, settings.fontFamily, settings.scrollback, tabId]);

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
  }, [visible, tabId]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: visible ? 'block' : 'none' }}
    />
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
