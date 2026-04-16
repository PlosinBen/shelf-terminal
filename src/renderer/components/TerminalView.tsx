import React, { useRef, useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { useStore, markUnread } from '../store';
import { getTheme } from '../themes';
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

// Cache xterm instances so they survive re-renders
const terminalCache = new Map<string, { term: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon }>();

// POSIX single-quote escape — works for nearly all POSIX shells.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function getSearchAddon(tabId: string): SearchAddon | null {
  return terminalCache.get(tabId)?.searchAddon ?? null;
}

export function TerminalView({ tabId, projectId, cwd, connection, initScript, tabCmd, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [initLoading, setInitLoading] = useState(!!(initScript || tabCmd));
  const { settings } = useStore();
  const theme = getTheme(settings.themeName);
  // Mirror current upload-size limit into a ref so the paste/drop handlers
  // (bound once at mount via [tabId] effect) always read the latest value.
  const maxUploadMBRef = useRef(settings.maxUploadSizeMB);
  maxUploadMBRef.current = settings.maxUploadSizeMB;

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
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      cached = { term, fitAddon, searchAddon };
      terminalCache.set(tabId, cached);
    }

    const { term, fitAddon } = cached;
    term.open(container);

    // Let browser handle Ctrl+V (paste) and Ctrl+C (copy when selected) on non-Mac
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

    // Upload pasted/dropped files into <cwd>/.tmp/shelf/ and type the resulting
    // shell-quoted paths into the terminal. Files exceeding the configured size
    // limit are skipped and reported via a single popup; successful files still
    // get inserted.
    const uploadFiles = async (files: File[]) => {
      const limitMB = maxUploadMBRef.current || 50;
      const maxBytes = limitMB * 1024 * 1024;

      const accepted: File[] = [];
      const oversized: File[] = [];
      for (const f of files) {
        if (f.size > maxBytes) oversized.push(f);
        else accepted.push(f);
      }

      if (oversized.length > 0) {
        const list = oversized
          .map((f) => `• ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`)
          .join('\n');
        void window.shelfApi.dialog.warn(
          'File too large',
          `The following file(s) exceed the ${limitMB} MB upload limit and were skipped:\n\n${list}\n\nYou can change the limit in Settings.`,
        );
      }

      if (accepted.length === 0) return;

      const results = await Promise.all(
        accepted.map(async (f) => {
          try {
            const buffer = await f.arrayBuffer();
            const result = await window.shelfApi.connector.uploadFile(connection, cwd, f.name, buffer);
            return { file: f, result };
          } catch (err: any) {
            return { file: f, result: { ok: false as const, reason: err?.message ?? String(err) } };
          }
        }),
      );

      const okPaths: string[] = [];
      const failures: { name: string; reason: string }[] = [];
      for (const { file, result } of results) {
        if (result.ok) okPaths.push(shellQuote(result.remotePath));
        else failures.push({ name: file.name, reason: result.reason });
      }

      if (okPaths.length > 0) {
        window.shelfApi.pty.input(tabId, okPaths.join(' '));
      }

      if (failures.length > 0) {
        const list = failures.map((f) => `• ${f.name}: ${f.reason}`).join('\n');
        void window.shelfApi.dialog.warn('Upload failed', list);
      }
    };

    // Paste: intercept when clipboard contains files (any type, not just images)
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const itemArr = Array.from(items);
      // text/html means rich text copy (e.g. browser) where any image is just
      // a favicon — let xterm handle it as text paste
      if (itemArr.some((it) => it.type === 'text/html')) return;

      const files: File[] = [];
      for (const item of itemArr) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;

      e.preventDefault();
      await uploadFiles(files);
    };
    // Use capture phase so we intercept before xterm's own paste handler
    container.addEventListener('paste', handlePaste, true);

    // Drag & drop: any file type
    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const handleDrop = async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      await uploadFiles(Array.from(files));
    };
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);

    return () => {
      onDataDispose.dispose();
      onResizeDispose.dispose();
      removeDataListener();
      removeInitSentListener();
      resizeObserver.disconnect();
      container.removeEventListener('paste', handlePaste, true);
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
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
