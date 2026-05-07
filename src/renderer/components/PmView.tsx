import React, { useState, useEffect, useReducer, useRef, useCallback, useMemo } from 'react';
import { useStore, setAwayMode, setPmVisible, updateSettings } from '../store';
import { renderMarkdown } from '../utils/markdown';
import type { PmMessage, PmStreamChunk, PmToolCall, AppSettings } from '@shared/types';
import { getModelsForProvider } from '@shared/types';
import { pmStreamReducer, initialPmStreamState, type PmStreamAction } from './pm-view-reducer';

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;

type SetMessages = React.Dispatch<React.SetStateAction<PmMessage[]>>;

async function handleSlashCommand(
  text: string,
  settings: AppSettings,
  setMessages: SetMessages,
  dispatch: React.Dispatch<PmStreamAction>,
): Promise<boolean> {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/clear':
      await window.shelfApi.pm.clear();
      setMessages([]);
      dispatch({ type: 'clear_display' });
      return true;

    case '/compact': {
      const result = await window.shelfApi.pm.compact();
      setMessages((prev) => {
        const kept = prev.slice(-result.kept);
        return [...kept, { role: 'assistant' as const, content: `Compacted: removed ${result.removed} messages, kept ${result.kept}.`, timestamp: Date.now() }];
      });
      return true;
    }

    case '/model': {
      const provider = settings.pmProvider?.provider;
      if (!provider) {
        setMessages((prev) => [...prev, { role: 'error', content: 'No provider configured.', timestamp: Date.now() }]);
        return true;
      }
      const models = getModelsForProvider(provider, settings.providerModels);
      if (!arg) {
        const current = settings.pmProvider?.model || '(none)';
        const list = models.map((m) => `  ${m.id === current ? '● ' : '  '}${m.id}`).join('\n');
        setMessages((prev) => [...prev, { role: 'assistant' as const, content: `Current model: **${current}**\n\nAvailable:\n\`\`\`\n${list}\n\`\`\``, timestamp: Date.now() }]);
        return true;
      }
      const match = models.find((m) => m.id === arg);
      if (!match) {
        setMessages((prev) => [...prev, { role: 'error', content: `Unknown model: ${arg}\nAvailable: ${models.map((m) => m.id).join(', ')}`, timestamp: Date.now() }]);
        return true;
      }
      updateSettings({ pmProvider: { ...settings.pmProvider!, model: match.id } });
      setMessages((prev) => [...prev, { role: 'assistant' as const, content: `Model switched to **${match.id}**`, timestamp: Date.now() }]);
      return true;
    }

    default:
      return false;
  }
}

export function PmView() {
  const { settings, awayMode } = useStore();
  const [messages, setMessages] = useState<PmMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamState, dispatch] = useReducer(pmStreamReducer, initialPmStreamState);
  const { streaming, streamText, streamToolCalls, error } = streamState;
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');

    if (text.startsWith('/')) {
      const handled = await handleSlashCommand(text, settings, setMessages, dispatch);
      if (handled) return;
    }

    setMessages((prev) => [...prev, { role: 'user', content: text, timestamp: Date.now() }]);
    dispatch({ type: 'send_start' });
    await window.shelfApi.pm.send(text);
  }, [input, streaming, settings]);

  const handleStop = useCallback(() => {
    window.shelfApi.pm.stop();
  }, []);

  const handleClear = useCallback(async () => {
    await window.shelfApi.pm.clear();
    setMessages([]);
    dispatch({ type: 'clear_display' });
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
          <button className="pm-header-btn" onClick={() => setPmVisible(false)} title="Close">
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

