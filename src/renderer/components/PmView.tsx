import React, { useState, useEffect, useReducer, useRef, useCallback, useMemo } from 'react';
import { useStore, setAwayMode, toggleRightSidebar } from '../store';
import { renderMarkdown } from '../utils/markdown';
import type { PmMessage, PmStreamChunk, PmToolCall } from '@shared/types';
import { pmStreamReducer, initialPmStreamState } from './pm-view-reducer';

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;

// Read-only PM panel: PM is driven by tab events / Telegram, not in-app chat
// (you're at the computer — no need to relay through PM). No message input, no
// in-app slash commands. Model selection lives in Settings; history clears via
// the Clear History button.
export function PmView() {
  const { settings, awayMode, pmActive } = useStore();
  const hasTelegram = !!(settings.telegram?.botToken && settings.telegram?.chatId);
  const [messages, setMessages] = useState<PmMessage[]>([]);
  const [streamState, dispatch] = useReducer(pmStreamReducer, initialPmStreamState);
  const { streaming, streamText, streamToolCalls, error } = streamState;
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const listRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const hasProvider = !!(settings.pmProvider?.provider && settings.pmProvider?.apiKey && settings.pmProvider?.model);

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
      dispatch({ type: 'chunk', chunk });
      const isRetry = chunk.type === 'error' && (chunk.error ?? '').includes('Retrying in');
      if (chunk.type === 'done' || (chunk.type === 'error' && !isRetry)) {
        window.shelfApi.pm.history().then(setMessages);
      }
    });
    return off;
  }, []);

  const handleClear = useCallback(async () => {
    await window.shelfApi.pm.clear();
    setMessages([]);
    dispatch({ type: 'clear_display' });
  }, []);

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

  return (
    <div className="right-panel pm-panel" style={{ width }}>
      <div className="right-panel-resize-handle pm-resize-handle" onMouseDown={onDragStart} />
      <div className="right-panel-header pm-header">
        <span className="right-panel-title pm-header-title">PM</span>
        <span className="pm-header-actions">
          <button
            className={`pm-active-toggle ${pmActive ? 'pm-active-on' : ''}`}
            onClick={() => window.shelfApi.pm.setActive(!pmActive)}
            disabled={!hasTelegram}
            title={!hasTelegram
              ? 'Configure Telegram in Settings to enable PM Active'
              : pmActive ? 'PM Active ON — telegram listener running (click to stop)' : 'PM Active OFF (click to start)'}
          >
            {pmActive ? 'PM ON' : 'PM OFF'}
          </button>
          <button
            className={`pm-away-toggle ${awayMode ? 'pm-away-on' : ''}`}
            onClick={() => window.shelfApi.pm.setAwayMode(!awayMode)}
            disabled={!pmActive}
            title={!pmActive
              ? 'Enable PM Active first'
              : awayMode ? 'Away Mode ON — PM can control terminals' : 'Away Mode OFF — read only'}
          >
            {awayMode ? 'Away ON' : 'Away OFF'}
          </button>
          <button className="pm-header-btn" onClick={handleClear} title="Clear conversation history">
            Clear History
          </button>
          <button className="pm-header-btn" onClick={() => toggleRightSidebar('pm')} title="Close">
            ×
          </button>
        </span>
      </div>
      {!hasProvider && (
        <div className="pm-no-provider">
          Configure PM provider in Settings
        </div>
      )}
      <div className="pm-messages" ref={listRef}>
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {streaming && (streamText || streamToolCalls.length > 0) && (
          <div className="pm-msg pm-msg-assistant">
            {streamToolCalls.map((tc) => (
              <ToolCallSummary key={tc.id} toolCall={tc} />
            ))}
            {streamText && <div className="pm-msg-md" dangerouslySetInnerHTML={{ __html: renderPmMarkdown(streamText) }} />}
          </div>
        )}
        {streaming && !streamText && streamToolCalls.length === 0 && (
          <div className="pm-msg pm-msg-assistant">
            <span className="pm-thinking">Thinking...</span>
          </div>
        )}
        {error && (
          <div className="pm-error" onClick={() => dispatch({ type: 'dismiss_error' })}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function renderPmMarkdown(text: string): string {
  return renderMarkdown(text, { breaks: true });
}

function MessageBubble({ message }: { message: PmMessage }) {
  if (message.role === 'error') {
    return <div className="pm-error">{message.content}</div>;
  }
  const isUser = message.role === 'user';
  const html = useMemo(
    () => (!isUser && message.content ? renderPmMarkdown(message.content) : ''),
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

