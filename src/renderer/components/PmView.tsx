import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore, setAwayMode, updateSettings } from '../store';
import type { PmMessage, PmStreamChunk, PmToolCall } from '@shared/types';

export function PmView() {
  const { settings, awayMode } = useStore();
  const [messages, setMessages] = useState<PmMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamToolCalls, setStreamToolCalls] = useState<PmToolCall[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
        case 'error':
          setStreaming(false);
          setStreamText('');
          setStreamToolCalls([]);
          window.shelfApi.pm.history().then(setMessages);
          break;
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (showSettings || !hasProvider) {
    return <PmProviderSettings onDone={() => setShowSettings(false)} />;
  }

  return (
    <div className="pm-view">
      <div className="pm-header">
        <span className="pm-header-title">PM Agent</span>
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
            {streamText && <div className="pm-msg-text">{streamText}</div>}
          </div>
        )}
        {streaming && !streamText && streamToolCalls.length === 0 && (
          <div className="pm-msg pm-msg-assistant">
            <span className="pm-thinking">Thinking...</span>
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

function MessageBubble({ message }: { message: PmMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`pm-msg ${isUser ? 'pm-msg-user' : 'pm-msg-assistant'}`}>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="pm-tool-calls">
          {message.toolCalls.map((tc) => (
            <ToolCallSummary key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
      {message.content && <div className="pm-msg-text">{message.content}</div>}
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
