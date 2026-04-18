import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentProvider, Connection } from '@shared/types';
import { AgentMessage, type AgentMsg } from './AgentMessage';

const AGENT_PROVIDERS: { id: AgentProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'gemini', label: 'Gemini' },
];

interface AgentViewProps {
  tabId: string;
  projectId: string;
  projectIndex: number;
  cwd: string;
  connection: Connection;
  initScript?: string;
  provider?: AgentProvider;
  visible: boolean;
  onSelectProvider: (tabId: string, provider: AgentProvider) => void;
}

let msgCounter = 0;

export function AgentView({ tabId, projectId, cwd, connection, initScript, provider, visible, onSelectProvider }: AgentViewProps) {
  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string | undefined>();
  const [cost, setCost] = useState<number | undefined>();
  const [permissionMode, setPermissionMode] = useState('default');
  const [pendingPermission, setPendingPermission] = useState<{ toolUseId: string; toolName: string; input: Record<string, unknown> } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingTextRef = useRef<string>('');
  const streamingIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    const offMessage = window.shelfApi.agent.onMessage((payload) => {
      if (payload.tabId !== tabId) return;

      if (payload.type === 'text') {
        streamingIdRef.current = null;
        streamingTextRef.current = '';
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [
          ...prev.filter((m) => !m.streaming || m.type !== 'text'),
          { id, role: 'assistant', type: 'text', content: payload.content, provider },
        ]);
        scrollToBottom();
      } else if (payload.type === 'thinking') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [...prev, { id, role: 'assistant', type: 'thinking', content: payload.content }]);
        scrollToBottom();
      } else if (payload.type === 'tool_use') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [
          ...prev,
          { id, role: 'tool', type: 'tool_use', content: '', toolName: payload.toolName, toolInput: payload.toolInput, toolUseId: payload.toolUseId, streaming: true },
        ]);
        scrollToBottom();
      } else if (payload.type === 'tool_result') {
        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.toolUseId === payload.toolUseId && m.type === 'tool_use'
              ? { ...m, streaming: false }
              : m,
          );
          const id = `msg-${++msgCounter}`;
          return [...updated, { id, role: 'tool' as const, type: 'tool_result' as const, content: payload.content, toolUseId: payload.toolUseId }];
        });
        scrollToBottom();
      } else if (payload.type === 'system') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [...prev, { id, role: 'system', type: 'system', content: payload.content }]);
        scrollToBottom();
      } else if (payload.type === 'result') {
        streamingIdRef.current = null;
        setMessages((prev) => prev.filter((m) => !m.streaming));
        scrollToBottom();
      } else if (payload.type === 'error') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [...prev, { id, role: 'system', type: 'error', content: payload.content }]);
        scrollToBottom();
      }
    });

    const offStream = window.shelfApi.agent.onStream((payload) => {
      if (payload.tabId !== tabId) return;

      if (payload.type === 'text') {
        streamingTextRef.current += payload.content;
        const text = streamingTextRef.current;

        if (!streamingIdRef.current) {
          streamingIdRef.current = `msg-${++msgCounter}`;
        }
        const id = streamingIdRef.current;

        setMessages((prev) => {
          const existingIdx = prev.findIndex((m) => m.id === id);
          const msg: AgentMsg = { id, role: 'assistant', type: 'text', content: text, provider, streaming: true };
          if (existingIdx >= 0) {
            return prev.map((m, i) => (i === existingIdx ? msg : m));
          }
          return [...prev, msg];
        });
        scrollToBottom();
      }
    });

    const offStatus = window.shelfApi.agent.onStatus((payload) => {
      if (payload.tabId !== tabId) return;
      setStreaming(payload.state === 'streaming');
      if (payload.model) setModel(payload.model);
      if (payload.costUsd !== undefined) setCost(payload.costUsd);
    });

    const offError = window.shelfApi.agent.onError((payload) => {
      if (payload.tabId !== tabId) return;
      setStreaming(false);
      const id = `msg-${++msgCounter}`;
      setMessages((prev) => [...prev, { id, role: 'system', type: 'error', content: payload.error }]);
      scrollToBottom();
    });

    const offPermission = window.shelfApi.agent.onPermissionRequest((payload) => {
      if (payload.tabId !== tabId) return;
      setPendingPermission({ toolUseId: payload.toolUseId, toolName: payload.toolName, input: payload.input });
    });

    return () => { offMessage(); offStream(); offStatus(); offError(); offPermission(); };
  }, [tabId, provider, scrollToBottom]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || streaming || !provider) return;

    const id = `msg-${++msgCounter}`;
    setMessages((prev) => [...prev, { id, role: 'user', type: 'text', content: text }]);
    setInput('');
    streamingTextRef.current = '';
    streamingIdRef.current = null;
    scrollToBottom();

    window.shelfApi.agent.send(tabId, text, cwd, provider, connection, initScript);
  }, [input, streaming, provider, tabId, cwd, connection, initScript, scrollToBottom]);

  const handleStop = useCallback(() => {
    window.shelfApi.agent.stop(tabId);
  }, [tabId]);

  const handlePermissionAllow = useCallback(() => {
    if (pendingPermission) {
      window.shelfApi.agent.resolvePermission(tabId, pendingPermission.toolUseId, true);
      setPendingPermission(null);
    }
  }, [tabId, pendingPermission]);

  const handlePermissionDeny = useCallback(() => {
    if (pendingPermission) {
      window.shelfApi.agent.resolvePermission(tabId, pendingPermission.toolUseId, false);
      setPendingPermission(null);
    }
  }, [tabId, pendingPermission]);

  const handleModeChange = useCallback((mode: string) => {
    setPermissionMode(mode);
    window.shelfApi.agent.setMode(tabId, mode);
  }, [tabId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && streaming) {
      e.preventDefault();
      handleStop();
    }
  }, [handleSend, handleStop, streaming]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }, [input]);

  if (!visible) return null;

  if (!provider) {
    return (
      <div className="agent-view">
        <div className="agent-provider-picker">
          <span className="agent-picker-title">Select Agent Provider</span>
          <div className="agent-picker-options">
            {AGENT_PROVIDERS.map((p) => (
              <button
                key={p.id}
                className="agent-picker-btn"
                onClick={() => onSelectProvider(tabId, p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-view agent-view-active">
      <div className="agent-status-bar">
        <span>{provider.charAt(0).toUpperCase() + provider.slice(1)}</span>
        {model && <span className="agent-status-model">{model}</span>}
        {cost !== undefined && <span className="agent-status-cost">${cost.toFixed(4)}</span>}
      </div>

      <div className="agent-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="agent-empty">Send a message to start</div>
        )}
        {messages.map((msg) => (
          <AgentMessage key={msg.id} message={msg} />
        ))}
      </div>

      {pendingPermission && (
        <div className="agent-permission">
          <div className="agent-permission-header">Permission Required</div>
          <div className="agent-permission-tool">{pendingPermission.toolName}</div>
          <pre className="agent-permission-input">{JSON.stringify(pendingPermission.input, null, 2)}</pre>
          <div className="agent-permission-actions">
            <button className="agent-btn agent-btn-stop" onClick={handlePermissionDeny}>Deny</button>
            <button className="agent-btn agent-btn-send" onClick={handlePermissionAllow}>Allow</button>
          </div>
        </div>
      )}

      <div className="agent-input-area">
        <textarea
          ref={textareaRef}
          className="agent-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message..."
          rows={1}
          disabled={streaming}
        />
        <div className="agent-input-actions">
          <select
            className="agent-mode-select"
            value={permissionMode}
            onChange={(e) => handleModeChange(e.target.value)}
            title="Permission mode"
          >
            <option value="default">Default</option>
            <option value="acceptEdits">Accept Edits</option>
            <option value="bypassPermissions">Bypass</option>
          </select>
          {streaming ? (
            <button className="agent-btn agent-btn-stop" onClick={handleStop}>Stop</button>
          ) : (
            <button className="agent-btn agent-btn-send" onClick={handleSend} disabled={!input.trim()}>Send</button>
          )}
        </div>
      </div>
    </div>
  );
}
