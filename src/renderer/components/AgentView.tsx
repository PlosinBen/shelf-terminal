import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentProvider, Connection } from '@shared/types';
import { AgentMessage, type AgentMsg } from './AgentMessage';
import { saveMessage, loadMessages, clearMessages } from '../agent-history';
import { updateProjectConfig } from '../store';

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

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatResetTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

export function AgentView({ tabId, projectId, projectIndex, cwd, connection, initScript, provider, visible, onSelectProvider }: AgentViewProps) {
  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string | undefined>();
  const [cost, setCost] = useState<number | undefined>();
  const [permissionMode, setPermissionMode] = useState('default');
  const [pendingPermission, setPendingPermission] = useState<{ toolUseId: string; toolName: string; input: Record<string, unknown> } | null>(null);
  const [tokens, setTokens] = useState({ input: 0, output: 0 });
  const [rateLimit, setRateLimit] = useState<{ type?: string; utilization?: number; resetsAt?: number } | null>(null);
  const [slashCommands, setSlashCommands] = useState<{ name: string; description: string }[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingTextRef = useRef<string>('');
  const streamingIdRef = useRef<string | null>(null);

  // Load history on mount
  useEffect(() => {
    if (!provider) return;
    loadMessages(projectId).then((persisted) => {
      if (persisted.length > 0) {
        const loaded: AgentMsg[] = persisted.map((m) => ({
          id: `hist-${++msgCounter}`,
          role: m.role,
          type: m.type,
          content: m.content,
          provider: m.provider,
          toolName: m.toolName,
          toolUseId: m.toolUseId,
          toolInput: m.toolInput ? JSON.parse(m.toolInput) : undefined,
        }));
        setMessages(loaded);
      }
    });
  }, [projectId, provider]);

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
        persistMsg('assistant', 'text', payload.content);
        scrollToBottom();
      } else if (payload.type === 'thinking') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [...prev, { id, role: 'assistant', type: 'thinking', content: payload.content }]);
        persistMsg('assistant', 'thinking', payload.content);
        scrollToBottom();
      } else if (payload.type === 'tool_use') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [
          ...prev,
          { id, role: 'tool', type: 'tool_use', content: '', toolName: payload.toolName, toolInput: payload.toolInput, toolUseId: payload.toolUseId, streaming: true },
        ]);
        persistMsg('tool', 'tool_use', '', { toolName: payload.toolName, toolUseId: payload.toolUseId, toolInput: payload.toolInput });
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
        persistMsg('tool', 'tool_result', payload.content, { toolUseId: payload.toolUseId });
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
      if (payload.sessionId && provider) {
        updateProjectConfig(projectIndex, {
          agentSessionIds: { ...({} as any), [provider]: payload.sessionId },
        });
      }
      if (payload.state === 'idle' && slashCommands.length === 0) {
        window.shelfApi.agent.slashCommands(tabId).then((cmds) => {
          if (cmds.length > 0) setSlashCommands(cmds);
        });
      }
      if (payload.model) setModel(payload.model);
      if (payload.costUsd !== undefined) setCost(payload.costUsd);
      if (payload.inputTokens !== undefined || payload.outputTokens !== undefined) {
        setTokens((prev) => ({
          input: payload.inputTokens ?? prev.input,
          output: payload.outputTokens ?? prev.output,
        }));
      }
      if ((payload as any).rateLimit) {
        const rl = (payload as any).rateLimit;
        setRateLimit({ type: rl.rateLimitType, utilization: rl.utilization, resetsAt: rl.resetsAt });
      }
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

  const persistMsg = useCallback((role: 'user' | 'assistant' | 'system' | 'tool', type: string, content: string, extra?: { toolName?: string; toolUseId?: string; toolInput?: Record<string, unknown> }) => {
    saveMessage({
      projectId,
      timestamp: Date.now(),
      role,
      type: type as any,
      content,
      provider,
      toolName: extra?.toolName,
      toolUseId: extra?.toolUseId,
      toolInput: extra?.toolInput ? JSON.stringify(extra.toolInput) : undefined,
    });
  }, [projectId, provider]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || streaming || !provider) return;

    const id = `msg-${++msgCounter}`;
    setMessages((prev) => [...prev, { id, role: 'user', type: 'text', content: text }]);
    persistMsg('user', 'text', text);
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

  const handleSwitchProvider = useCallback(async (newProvider: AgentProvider) => {
    if (newProvider === provider || streaming) return;
    const confirmed = await window.shelfApi.dialog.confirm(
      `Switch to ${newProvider.charAt(0).toUpperCase() + newProvider.slice(1)}`,
      `Current session will be paused and can be resumed later.\nContext will not transfer between providers.`,
      'Switch',
    );
    if (!confirmed) return;

    await window.shelfApi.agent.switchProvider(tabId, newProvider, connection, initScript);
    const id = `msg-${++msgCounter}`;
    setMessages((prev) => [
      ...prev.map((m) => ({ ...m, streaming: false })),
      { id, role: 'system' as const, type: 'system' as const, content: `── Switched to ${newProvider.charAt(0).toUpperCase() + newProvider.slice(1)} ──` },
    ]);
    setModel(undefined);
    setCost(undefined);
    setTokens({ input: 0, output: 0 });
    setRateLimit(null);
    setSlashCommands([]);
    onSelectProvider(tabId, newProvider);
  }, [tabId, provider, connection, initScript, streaming, onSelectProvider]);

  const handleReset = useCallback(async () => {
    await window.shelfApi.agent.destroy(tabId);
    await clearMessages(projectId);
    setMessages([]);
    setStreaming(false);
    setModel(undefined);
    setCost(undefined);
    setPendingPermission(null);
    streamingTextRef.current = '';
    streamingIdRef.current = null;
  }, [tabId, projectId]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    if (val.startsWith('/') && !val.includes('\n')) {
      setSlashFilter(val.slice(1).toLowerCase());
      setShowSlashMenu(true);
    } else {
      setShowSlashMenu(false);
    }
  }, []);

  const handleSlashSelect = useCallback((name: string) => {
    setInput('/' + name + ' ');
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showSlashMenu) {
        const filtered = slashCommands.filter((c) => c.name.toLowerCase().includes(slashFilter));
        if (filtered.length > 0) {
          handleSlashSelect(filtered[0].name);
          return;
        }
      }
      handleSend();
    }
    if (e.key === 'Escape') {
      if (showSlashMenu) {
        setShowSlashMenu(false);
        return;
      }
      if (streaming) {
        e.preventDefault();
        handleStop();
      }
    }
  }, [handleSend, handleStop, streaming, showSlashMenu, slashFilter, slashCommands, handleSlashSelect]);

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
        <select
          className="agent-provider-switch"
          value={provider}
          onChange={(e) => handleSwitchProvider(e.target.value as AgentProvider)}
          disabled={streaming}
        >
          {AGENT_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {model && <span className="agent-status-model">{model}</span>}
        {(tokens.input > 0 || tokens.output > 0) && (
          <span className="agent-status-tokens" title="Input / Output tokens">
            {formatTokens(tokens.input)} / {formatTokens(tokens.output)}
          </span>
        )}
        {rateLimit?.utilization !== undefined && (
          <span className={`agent-status-rate ${rateLimit.utilization > 0.8 ? 'warning' : ''}`} title={rateLimit.type ?? 'Rate limit'}>
            {Math.round(rateLimit.utilization * 100)}%
            {rateLimit.resetsAt && <span className="agent-rate-reset"> resets {formatResetTime(rateLimit.resetsAt)}</span>}
          </span>
        )}
        {cost !== undefined && <span className="agent-status-cost">${cost.toFixed(4)}</span>}
        <button className="agent-reset-btn" onClick={handleReset} disabled={streaming} title="Reset session">Reset</button>
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

      {showSlashMenu && slashCommands.length > 0 && (() => {
        const filtered = slashCommands.filter((c) => c.name.toLowerCase().includes(slashFilter));
        if (filtered.length === 0) return null;
        return (
          <div className="agent-slash-menu">
            {filtered.slice(0, 10).map((cmd) => (
              <button
                key={cmd.name}
                className="agent-slash-item"
                onMouseDown={(e) => { e.preventDefault(); handleSlashSelect(cmd.name); }}
              >
                <span className="agent-slash-name">/{cmd.name}</span>
                <span className="agent-slash-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        );
      })()}

      <div className="agent-input-area">
        <textarea
          ref={textareaRef}
          className="agent-textarea"
          value={input}
          onChange={handleInputChange}
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
