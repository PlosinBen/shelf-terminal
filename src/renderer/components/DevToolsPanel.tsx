import React, { useState, useCallback, useRef } from 'react';
import { useStore, toggleDevTools } from '../store';

// ── Tool definitions ──

type ToolId = 'base64' | 'json' | 'url' | 'uuid' | 'timestamp' | 'hash';

interface ToolDef {
  id: ToolId;
  label: string;
}

const TOOLS: ToolDef[] = [
  { id: 'base64', label: 'Base64' },
  { id: 'json', label: 'JSON' },
  { id: 'url', label: 'URL Encode' },
  { id: 'uuid', label: 'UUID' },
  { id: 'timestamp', label: 'Timestamp' },
  { id: 'hash', label: 'Hash' },
];

// ── Tool logic ──

function base64Encode(input: string): string {
  try { return btoa(unescape(encodeURIComponent(input))); }
  catch { return '[Error] Failed to encode'; }
}

function base64Decode(input: string): string {
  try { return decodeURIComponent(escape(atob(input.trim()))); }
  catch { return '[Error] Invalid Base64'; }
}

function jsonFormat(input: string): string {
  try { return JSON.stringify(JSON.parse(input), null, 2); }
  catch { return '[Error] Invalid JSON'; }
}

function jsonMinify(input: string): string {
  try { return JSON.stringify(JSON.parse(input)); }
  catch { return '[Error] Invalid JSON'; }
}

function urlEncode(input: string): string {
  return encodeURIComponent(input);
}

function urlDecode(input: string): string {
  try { return decodeURIComponent(input); }
  catch { return '[Error] Invalid URL encoding'; }
}

function generateUUID(): string {
  return crypto.randomUUID();
}

function timestampConvert(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    const now = Date.now();
    return `${Math.floor(now / 1000)} (ms: ${now})`;
  }
  // Try as number (unix timestamp)
  const n = Number(trimmed);
  if (!isNaN(n)) {
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '[Error] Invalid timestamp';
    return `${d.toISOString()} (${d.toLocaleString()})`;
  }
  // Try as date string
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return '[Error] Invalid date or timestamp';
  const sec = Math.floor(d.getTime() / 1000);
  return `${sec} (ms: ${d.getTime()})`;
}

async function computeHash(input: string, algo: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest(algo, data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Tools that need multi-line input/output use textarea; others use single-line input
function useTextarea(id: ToolId): boolean {
  return id === 'base64' || id === 'json' || id === 'url' || id === 'hash';
}

// ── Per-tool section components ──

function ToolSection({ id, label, expanded, onToggle }: { id: ToolId; label: string; expanded: boolean; onToggle: () => void }) {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [copied, setCopied] = useState(false);

  const copyOutput = useCallback(() => {
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [output]);

  const run = useCallback(async (action: string) => {
    let result = '';
    switch (id) {
      case 'base64':
        result = action === 'encode' ? base64Encode(input) : base64Decode(input);
        break;
      case 'json':
        result = action === 'format' ? jsonFormat(input) : jsonMinify(input);
        break;
      case 'url':
        result = action === 'encode' ? urlEncode(input) : urlDecode(input);
        break;
      case 'uuid':
        result = generateUUID();
        break;
      case 'timestamp':
        result = timestampConvert(input);
        break;
      case 'hash':
        result = await computeHash(input, action);
        break;
    }
    setOutput(result);
  }, [id, input]);

  return (
    <div className="devtools-section">
      <button className="devtools-section-header" onClick={onToggle}>
        <span className="devtools-section-arrow">{expanded ? '▼' : '▶'}</span>
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="devtools-section-body">
          {id !== 'uuid' && (
            useTextarea(id)
              ? <textarea
                  className="devtools-textarea"
                  placeholder="Input..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  rows={8}
                />
              : <input
                  className="devtools-input"
                  placeholder={id === 'timestamp' ? 'Unix timestamp...' : 'Input...'}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
          )}
          <div className="devtools-actions">
            <ToolActions id={id} onAction={run} />
          </div>
          {output && (
            <div className="devtools-output-wrap">
              {useTextarea(id)
                ? <textarea
                    className="devtools-textarea devtools-output"
                    value={output}
                    readOnly
                    rows={8}
                  />
                : <input
                    className="devtools-input devtools-output"
                    value={output}
                    readOnly
                  />
              }
              <button className="devtools-copy-btn" onClick={copyOutput} title="Copy">
                {copied ? '✓' : '📋'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolActions({ id, onAction }: { id: ToolId; onAction: (action: string) => void }) {
  switch (id) {
    case 'base64':
      return (
        <>
          <button className="devtools-btn" onClick={() => onAction('encode')}>Encode</button>
          <button className="devtools-btn" onClick={() => onAction('decode')}>Decode</button>
        </>
      );
    case 'json':
      return (
        <>
          <button className="devtools-btn" onClick={() => onAction('format')}>Format</button>
          <button className="devtools-btn" onClick={() => onAction('minify')}>Minify</button>
        </>
      );
    case 'url':
      return (
        <>
          <button className="devtools-btn" onClick={() => onAction('encode')}>Encode</button>
          <button className="devtools-btn" onClick={() => onAction('decode')}>Decode</button>
        </>
      );
    case 'uuid':
      return <button className="devtools-btn" onClick={() => onAction('generate')}>Generate</button>;
    case 'timestamp':
      return <button className="devtools-btn" onClick={() => onAction('convert')}>Convert</button>;
    case 'hash':
      return (
        <>
          <button className="devtools-btn" onClick={() => onAction('SHA-256')}>SHA-256</button>
          <button className="devtools-btn" onClick={() => onAction('SHA-1')}>SHA-1</button>
          <button className="devtools-btn" onClick={() => onAction('SHA-512')}>SHA-512</button>
        </>
      );
  }
}

// ── Main panel ──

const MIN_WIDTH = 240;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

export function DevToolsPanel() {
  const { devToolsVisible } = useStore();
  const [expandedTools, setExpandedTools] = useState<Set<ToolId>>(new Set(['base64']));
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);

  const toggle = (id: ToolId) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = width;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX; // dragging left = wider
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(next);
    };

    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width]);

  if (!devToolsVisible) return null;

  return (
    <div className="devtools-panel" style={{ width }}>
      <div className="devtools-resize-handle" onMouseDown={onDragStart} />
      <div className="devtools-header">
        <span>Dev Tools</span>
        <button className="settings-close" onClick={toggleDevTools}>×</button>
      </div>
      <div className="devtools-body">
        {TOOLS.map((tool) => (
          <ToolSection
            key={tool.id}
            id={tool.id}
            label={tool.label}
            expanded={expandedTools.has(tool.id)}
            onToggle={() => toggle(tool.id)}
          />
        ))}
      </div>
    </div>
  );
}
