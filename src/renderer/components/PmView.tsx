import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore, setAwayMode, updateSettings, setPmVisible } from '../store';
import { marked } from 'marked';
import type { PmMessage, PmStreamChunk, PmToolCall } from '@shared/types';

marked.setOptions({ breaks: true, gfm: true });

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;

export function PmView() {
  const { settings, awayMode } = useStore();
  const [messages, setMessages] = useState<PmMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamToolCalls, setStreamToolCalls] = useState<PmToolCall[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);

  const hasProvider = !!(settings.pmProvider?.baseUrl && settings.pmProvider?.apiKey && settings.pmProvider?.model);

  useEffect(() => {
    window.shelfApi.pm.history().then(setMessages);
    window.shelfApi.pm.getAwayMode().then(setAwayMode);
  }, []);

  useEffect(() => {
    return window.shelfApi.pm.onAwayMode(setAwayMode);
  }, []);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streamText, streamToolCalls]);

  useEffect(() => {
    const off = window.shelfApi.pm.onStream((chunk: PmStreamChunk) => {
      switch (chunk.type) {
        case 'text':
          setStreamText((prev) => prev + (chunk.text ?? ''));
          break;
        case 'tool_start':
          if (chunk.toolCall) {
            setStreamToolCalls((prev) => [...prev, chunk.toolCall!]);
          }
          break;
        case 'tool_result':
          if (chunk.toolCall) {
            setStreamToolCalls((prev) =>
              prev.map((tc) => (tc.id === chunk.toolCall!.id ? chunk.toolCall! : tc)),
            );
          }
          break;
        case 'done':
          setStreaming(false);
          setStreamText('');
          setStreamToolCalls([]);
          window.shelfApi.pm.history().then(setMessages);
          break;
        case 'error': {
          const errMsg = chunk.error ?? 'Unknown error';
          const isRetrying = errMsg.includes('Retrying in');
          if (isRetrying) {
            setError(errMsg);
          } else {
            setStreaming(false);
            setStreamText('');
            setStreamToolCalls([]);
            setError(null);
            window.shelfApi.pm.history().then(setMessages);
          }
          break;
        }
      }
    });
    return off;
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text, timestamp: Date.now() }]);
    setStreaming(true);
    setStreamText('');
    setStreamToolCalls([]);
    setError(null);
    await window.shelfApi.pm.send(text);
  }, [input, streaming]);

  const handleStop = useCallback(() => {
    window.shelfApi.pm.stop();
  }, []);

  const handleClear = useCallback(async () => {
    await window.shelfApi.pm.clear();
    setMessages([]);
    setStreamText('');
    setStreamToolCalls([]);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)));
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Provider settings
  if (showSettings || !hasProvider) {
    return (
      <div className="pm-panel" style={{ width }}>
        <div className="pm-resize-handle" onMouseDown={onDragStart} />
        <PmProviderSettings onDone={() => setShowSettings(false)} />
      </div>
    );
  }

  return (
    <div className="pm-panel" style={{ width }}>
      <div className="pm-resize-handle" onMouseDown={onDragStart} />
      <div className="pm-header">
        <span className="pm-header-title">PM</span>
        <span className="pm-header-actions">
          <button
            className={`pm-away-toggle ${awayMode ? 'pm-away-on' : ''}`}
            onClick={() => window.shelfApi.pm.setAwayMode(!awayMode)}
            title={awayMode ? 'Away Mode ON — PM can control terminals' : 'Away Mode OFF — read only'}
          >
            {awayMode ? 'Away ON' : 'Away OFF'}
          </button>
          <button className="pm-header-btn" onClick={handleClear} title="Clear conversation">
            Clear
          </button>
          <button className="pm-header-btn" onClick={() => setShowSettings(true)} title="Provider settings">
            &#9881;
          </button>
          <button className="pm-header-btn" onClick={() => setPmVisible(false)} title="Close">
            ×
          </button>
        </span>
      </div>
      <div className="pm-messages" ref={listRef}>
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {streaming && (streamText || streamToolCalls.length > 0) && (
          <div className="pm-msg pm-msg-assistant">
            {streamToolCalls.map((tc) => (
              <ToolCallSummary key={tc.id} toolCall={tc} />
            ))}
            {streamText && <div className="pm-msg-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamText) }} />}
          </div>
        )}
        {streaming && !streamText && streamToolCalls.length === 0 && (
          <div className="pm-msg pm-msg-assistant">
            <span className="pm-thinking">Thinking...</span>
          </div>
        )}
        {error && (
          <div className="pm-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
      </div>
      <div className="pm-input-area">
        <textarea
          ref={inputRef}
          className="pm-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask PM..."
          rows={2}
          disabled={streaming}
        />
        {streaming ? (
          <button className="pm-send-btn" onClick={handleStop}>Stop</button>
        ) : (
          <button className="pm-send-btn" onClick={handleSend} disabled={!input.trim()}>Send</button>
        )}
      </div>
    </div>
  );
}

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function MessageBubble({ message }: { message: PmMessage }) {
  if (message.role === 'error') {
    return <div className="pm-error">{message.content}</div>;
  }
  const isUser = message.role === 'user';
  const html = useMemo(
    () => (!isUser && message.content ? renderMarkdown(message.content) : ''),
    [message.content, isUser],
  );
  return (
    <div className={`pm-msg ${isUser ? 'pm-msg-user' : 'pm-msg-assistant'}`}>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="pm-tool-calls">
          {message.toolCalls.map((tc) => (
            <ToolCallSummary key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
      {isUser && message.content && <div className="pm-msg-text">{message.content}</div>}
      {!isUser && html && <div className="pm-msg-md" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

function ToolCallSummary({ toolCall }: { toolCall: PmToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="pm-tool-call">
      <button className="pm-tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="pm-tool-call-icon">{expanded ? '▼' : '▶'}</span>
        <span className="pm-tool-call-name">{toolCall.name}</span>
        {toolCall.result && <span className="pm-tool-call-done">✓</span>}
      </button>
      {expanded && (
        <div className="pm-tool-call-detail">
          <pre className="pm-tool-call-args">{JSON.stringify(toolCall.args, null, 2)}</pre>
          {toolCall.result && (
            <pre className="pm-tool-call-result">
              {toolCall.result.length > 500 ? toolCall.result.slice(0, 500) + '...' : toolCall.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PmProviderSettings({ onDone }: { onDone: () => void }) {
  const { settings } = useStore();
  const [baseUrl, setBaseUrl] = useState(settings.pmProvider?.baseUrl ?? 'https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState(settings.pmProvider?.apiKey ?? '');
  const [model, setModel] = useState(settings.pmProvider?.model ?? 'gpt-4o');

  const handleSave = () => {
    updateSettings({ pmProvider: { baseUrl, apiKey, model } });
    onDone();
  };

  return (
    <div className="pm-view">
      <div className="pm-header">
        <span className="pm-header-title">PM Provider Settings</span>
        <button className="pm-header-btn" onClick={() => setPmVisible(false)} title="Close">×</button>
      </div>
      <div className="pm-settings-form">
        <label className="pm-settings-label">
          Base URL
          <input
            className="pm-settings-input"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label className="pm-settings-label">
          API Key
          <input
            className="pm-settings-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
        </label>
        <label className="pm-settings-label">
          Model
          <input
            className="pm-settings-input"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o"
          />
        </label>
        <div className="pm-settings-actions">
          <button className="conn-btn conn-btn-cancel" onClick={onDone}>Cancel</button>
          <button className="conn-btn conn-btn-next" onClick={handleSave} disabled={!baseUrl || !apiKey || !model}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
