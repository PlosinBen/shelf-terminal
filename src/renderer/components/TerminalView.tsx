import React, { useRef, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  tabId: string;
  projectId: string;
  cwd: string;
  visible: boolean;
}

// Cache xterm instances so they survive re-renders
const terminalCache = new Map<string, { term: Terminal; fitAddon: FitAddon }>();

export function TerminalView({ tabId, projectId, cwd, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || initializedRef.current) return;
    initializedRef.current = true;

    let cached = terminalCache.get(tabId);
    if (!cached) {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: '#1e1e2e',
          foreground: '#cdd6f4',
          cursor: '#f5e0dc',
        },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      cached = { term, fitAddon };
      terminalCache.set(tabId, cached);
    }

    const { term, fitAddon } = cached;
    term.open(container);

    // Fit after open
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Spawn pty
    window.shelfApi.pty.spawn(projectId, tabId, cwd);

    // Terminal input → pty
    const onDataDispose = term.onData((data) => {
      window.shelfApi.pty.input(tabId, data);
    });

    // Pty output → terminal
    const removeDataListener = window.shelfApi.pty.onData((id, data) => {
      if (id === tabId) {
        term.write(data);
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

    // Image paste: intercept paste events on the container
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          const buffer = await blob.arrayBuffer();
          const filePath = await window.shelfApi.clipboard.saveImage(buffer);
          window.shelfApi.pty.input(tabId, filePath);
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
      // Don't dispose term — keep it cached for tab switching
    };
  }, [tabId, projectId]);

  // Re-fit when visibility changes
  useEffect(() => {
    if (visible) {
      const cached = terminalCache.get(tabId);
      if (cached) {
        requestAnimationFrame(() => {
          cached.fitAddon.fit();
          cached.term.focus();
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
    cached.term.dispose();
    terminalCache.delete(tabId);
  }
}
