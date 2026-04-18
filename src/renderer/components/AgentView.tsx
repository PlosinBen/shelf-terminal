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
  const [capabilities, setCapabilities] = useState<{ models: { value: string; displayName: string }[]; permissionModes: string[]; effortLevels: string[] } | null>(null);
  const [currentModel, setCurrentModel] = useState<string | undefined>();
  const [currentEffort, setCurrentEffort] = useState('high');
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running'>('idle');
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingTextRef = useRef<string>('');
  const streamingIdRef = useRef<string | null>(null);
  const isAtBottomRef = useRef(true);
  const initialScrollDone = useRef(false);
  const prevMessageCount = useRef(0);

  // Track whether user is scrolled to bottom
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const handleScroll = () => {
      isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Load history on mount
  useEffect(() => {
    if (!provider) return;
    loadMessages(projectId).then((persisted) => {
      if (persisted.length === 0) return;

      const msgs: AgentMsg[] = [];
      const toolUseMap = new Map<string, AgentMsg>();

      for (const m of persisted) {
        if (m.type === 'tool_result' && m.toolUseId) {
          const toolUse = toolUseMap.get(m.toolUseId);
          if (toolUse) {
            toolUse.toolResult = m.content;
          }
          continue;
        }

        const msg: AgentMsg = {
          id: `hist-${++msgCounter}`,
          role: m.role,
          type: m.type,
          content: m.content,
          provider: m.provider,
          toolName: m.toolName,
          toolUseId: m.toolUseId,
          toolInput: m.toolInput ? JSON.parse(m.toolInput) : undefined,
          cwd,
        };
        msgs.push(msg);

        if (m.type === 'tool_use' && m.toolUseId) {
          toolUseMap.set(m.toolUseId, msg);
        }
      }

      setMessages(msgs);
    });
  }, [projectId, provider]);

  const scrollToBottom = useCallback((force = false) => {
    if (!force && !isAtBottomRef.current) return;
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, []);

  // Auto-scroll on every render if at bottom (catches streaming updates)
  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // Force scroll on user message send
  useEffect(() => {
    const prev = prevMessageCount.current;
    prevMessageCount.current = messages.length;
    if (messages.length > prev) {
      const last = messages[messages.length - 1];
      if (last?.role === 'user') {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          isAtBottomRef.current = true;
        });
      }
    }
  }, [messages.length]);

  // Force scroll on initial history load
  useEffect(() => {
    if (!initialScrollDone.current && messages.length > 0) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
          isAtBottomRef.current = true;
        }
      }));
    }
  }, [messages.length]);

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
      } else if (payload.type === 'thinking') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [...prev, { id, role: 'assistant', type: 'thinking', content: payload.content }]);
        persistMsg('assistant', 'thinking', payload.content);
      } else if (payload.type === 'tool_use') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [
          ...prev,
          { id, role: 'tool', type: 'tool_use', content: '', toolName: payload.toolName, toolInput: payload.toolInput, toolUseId: payload.toolUseId, streaming: true, cwd },
        ]);
        persistMsg('tool', 'tool_use', '', { toolName: payload.toolName, toolUseId: payload.toolUseId, toolInput: payload.toolInput });
      } else if (payload.type === 'tool_result') {
        setMessages((prev) => prev.map((m) =>
          m.toolUseId === payload.toolUseId && m.type === 'tool_use'
            ? { ...m, streaming: false, toolResult: payload.content }
            : m,
        ));
        persistMsg('tool', 'tool_result', payload.content, { toolUseId: payload.toolUseId });
      } else if (payload.type === 'system') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [...prev, { id, role: 'system', type: 'system', content: payload.content }]);
      } else if (payload.type === 'result') {
        streamingIdRef.current = null;
        setMessages((prev) => prev.filter((m) => !m.streaming));
      } else if (payload.type === 'error') {
        const id = `msg-${++msgCounter}`;
        setMessages((prev) => [...prev, { id, role: 'system', type: 'error', content: payload.content }]);
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
      }
    });

    const offStatus = window.shelfApi.agent.onStatus((payload) => {
      if (payload.tabId !== tabId) return;
      const isStreaming = payload.state === 'streaming';
      setStreaming(isStreaming);
      setAgentStatus(isStreaming ? 'running' : 'idle');
      if (payload.model) setCurrentModel(payload.model);
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

    const offCapabilities = window.shelfApi.agent.onCapabilities((payload) => {
      if (payload.tabId !== tabId) return;
      setCapabilities({ models: payload.models, permissionModes: payload.permissionModes, effortLevels: payload.effortLevels });
      if (payload.slashCommands.length > 0) setSlashCommands(payload.slashCommands);
    });

    return () => { offMessage(); offStream(); offStatus(); offError(); offPermission(); offCapabilities(); };
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
    scrollToBottom(true);

    window.shelfApi.agent.send(tabId, text, cwd, provider, connection, initScript);
  }, [input, streaming, provider, tabId, cwd, connection, initScript, scrollToBottom]);

  const handleStop = useCallback(() => {
    window.shelfApi.agent.stop(tabId);
  }, [tabId]);

  const [permSelection, setPermSelection] = useState(0);

  useEffect(() => {
    setPermSelection(0);
  }, [pendingPermission?.toolUseId]);

  const handlePermissionRespond = useCallback((index: number) => {
    if (!pendingPermission) return;
    const allow = index < 2;
    window.shelfApi.agent.resolvePermission(tabId, pendingPermission.toolUseId, allow);
    setPendingPermission(null);
  }, [tabId, pendingPermission]);

  useEffect(() => {
    if (!pendingPermission) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPermSelection((p) => (p > 0 ? p - 1 : 2));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPermSelection((p) => (p < 2 ? p + 1 : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handlePermissionRespond(permSelection);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pendingPermission, permSelection, handlePermissionRespond]);

  const handleModeChange = useCallback((mode: string) => {
    setPermissionMode(mode);
    window.shelfApi.agent.setMode(tabId, mode);
  }, [tabId]);

  const handleCycleModel = useCallback(() => {
    if (!capabilities || capabilities.models.length === 0) return;
    const idx = capabilities.models.findIndex((m) => m.value === currentModel);
    const next = capabilities.models[(idx + 1) % capabilities.models.length];
    setCurrentModel(next.value);
    window.shelfApi.agent.setModel(tabId, next.value);
  }, [tabId, capabilities, currentModel]);

  const handleCycleMode = useCallback(() => {
    if (!capabilities || capabilities.permissionModes.length === 0) return;
    const idx = capabilities.permissionModes.indexOf(permissionMode);
    const next = capabilities.permissionModes[(idx + 1) % capabilities.permissionModes.length];
    setPermissionMode(next);
    window.shelfApi.agent.setMode(tabId, next);
  }, [tabId, capabilities, permissionMode]);

  const handleCycleEffort = useCallback(() => {
    if (!capabilities || capabilities.effortLevels.length === 0) return;
    const idx = capabilities.effortLevels.indexOf(currentEffort);
    const next = capabilities.effortLevels[(idx + 1) % capabilities.effortLevels.length];
    setCurrentEffort(next);
    window.shelfApi.agent.setEffort(tabId, next);
  }, [tabId, capabilities, currentEffort]);

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
    if (e.nativeEvent.isComposing) return;
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
      <div className="agent-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="agent-empty">Send a message to start</div>
        )}
        {(() => {
          const turns: { user?: AgentMsg; agent: AgentMsg[] }[] = [];
          for (const msg of messages) {
            if (msg.role === 'user') {
              turns.push({ user: msg, agent: [] });
            } else if (turns.length === 0) {
              turns.push({ agent: [msg] });
            } else {
              turns[turns.length - 1].agent.push(msg);
            }
          }
          return turns.map((turn, ti) => (
            <div key={turn.user?.id ?? `turn-${ti}`} className="agent-turn">
              {turn.user && <AgentMessage message={turn.user} />}
              {turn.agent.length > 0 && (
                <div className="agent-turn-response">
                  {turn.agent.map((msg) => (
                    <AgentMessage key={msg.id} message={msg} />
                  ))}
                </div>
              )}
            </div>
          ));
        })()}
        <div ref={bottomRef} />
      </div>

      {pendingPermission && (
        <div className="agent-permission">
          <div className="agent-permission-header">Allow {pendingPermission.toolName}?</div>
          <div className="agent-perm-options">
            {['Allow', 'Allow (this session)', 'Deny'].map((label, i) => (
              <div
                key={label}
                className={`agent-perm-option agent-perm-option-${i < 2 ? 'allow' : 'deny'}${permSelection === i ? ' selected' : ''}`}
                onClick={() => handlePermissionRespond(i)}
              >
                <span className="agent-perm-indicator">{permSelection === i ? '\u25b6' : ' '}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="agent-perm-hint">
            <kbd>&uarr;</kbd><kbd>&darr;</kbd> select &nbsp; <kbd>Enter</kbd> confirm
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
        <span className="agent-prompt">❯</span>
        <textarea
          ref={textareaRef}
          className="agent-textarea"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={streaming ? 'Agent is running... (Esc to stop)' : 'Message...'}
          rows={1}
          disabled={streaming}
        />
        <div className="agent-input-actions">
          {streaming ? (
            <button className="agent-btn agent-btn-stop" onClick={handleStop}>Stop</button>
          ) : (
            <button className="agent-btn agent-btn-send" onClick={handleSend} disabled={!input.trim()}>Send</button>
          )}
        </div>
      </div>

      <div className="agent-status-bar">
        <span className="agent-status-dot" style={{ color: agentStatus === 'running' ? '#e5c07b' : '#98c379' }}>
          {agentStatus === 'running' ? '\u25CF' : '\u25CF'}
        </span>
        <span className="agent-status-label">{agentStatus}</span>
        <span className="agent-status-sep">|</span>
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

        {currentModel && (
          <>
            <span className="agent-status-sep">|</span>
            <span className={`agent-status-seg ${capabilities ? 'agent-status-interactive' : ''}`} onClick={handleCycleModel}>
              {currentModel}
            </span>
          </>
        )}

        {capabilities && capabilities.permissionModes.length > 0 && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg agent-status-interactive" style={{ color: permissionMode === 'bypassPermissions' ? '#e06c75' : permissionMode === 'acceptEdits' ? '#e5c07b' : undefined }} onClick={handleCycleMode}>
              {permissionMode}
            </span>
          </>
        )}

        {capabilities && capabilities.effortLevels.length > 0 && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg agent-status-interactive" onClick={handleCycleEffort}>
              <span className="agent-status-seg-label">effort: </span>{currentEffort}
            </span>
          </>
        )}

        {(tokens.input > 0 || tokens.output > 0) && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg">{Math.round(tokens.input / 1000)}k+{Math.round(tokens.output / 1000)}k</span>
          </>
        )}

        {cost !== undefined && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg">${cost.toFixed(3)}</span>
          </>
        )}

        {rateLimit?.utilization !== undefined && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg" style={{ color: rateLimit.utilization > 0.8 ? '#e06c75' : rateLimit.utilization > 0.5 ? '#e5c07b' : undefined }}>
              {rateLimit.type === 'five_hour' ? '5h' : rateLimit.type === 'seven_day' ? '7d' : rateLimit.type ?? ''}: {Math.round(rateLimit.utilization * 100)}%
              {rateLimit.resetsAt && (() => {
                const diff = rateLimit.resetsAt! - Date.now();
                if (diff <= 0) return null;
                const mins = Math.ceil(diff / 60000);
                return <span> ↻{mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`}</span>;
              })()}
            </span>
          </>
        )}

        <span style={{ marginLeft: 'auto' }} />
        <button className="agent-reset-btn" onClick={handleReset} disabled={streaming} title="Reset session">Reset</button>
      </div>
    </div>
  );
}
