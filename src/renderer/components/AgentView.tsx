import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentProvider, AgentPrefs, Connection } from '@shared/types';
import { AgentMessage, type AgentMsg } from './AgentMessage';
import { clearMessages, loadMessages, saveMessage } from '../agent-history';
import {
  useAgentState, updateAgentState, addAgentMessage,
  deleteAgentState, useStore, updateProjectConfig,
} from '../store';

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

export function AgentView({ tabId, projectId, projectIndex, cwd, connection, initScript, provider, visible, onSelectProvider }: AgentViewProps) {
  const agentState = useAgentState(tabId);
  const { projects } = useStore();

  const persistAgentPref = useCallback((key: keyof AgentPrefs, value: string) => {
    if (!provider) return;
    const proj = projects[projectIndex];
    if (!proj) return;
    const existing = proj.config.agentPrefs?.[provider] ?? {};
    updateProjectConfig(projectIndex, {
      agentPrefs: { ...proj.config.agentPrefs, [provider]: { ...existing, [key]: value } },
    });
  }, [provider, projectIndex, projects]);
  const { messages, streaming, agentStatus, model, cost, tokens, rateLimit, contextInfo,
    capabilities, permissionMode, currentEffort, pendingPermission, queuedMessages, slashCommands,
    authRequired, authError, authBusy } = agentState;

  const [input, setInput] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [permSelection, setPermSelection] = useState(0);
  const [modelPicker, setModelPicker] = useState<{ open: boolean; selected: number }>({ open: false, selected: 0 });

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isAtBottomRef = useRef(false);
  const scrollRestoredRef = useRef(false);
  const prevMessageCount = useRef(0);

  // Bootstrap backend session (checkAuth + warmup) once provider is known, and
  // apply any persisted per-provider prefs so the chip UI reflects the last
  // chosen model/effort/mode even before the first turn.
  const initCalled = useRef(false);
  useEffect(() => {
    if (!provider || initCalled.current) return;
    initCalled.current = true;
    window.shelfApi.agent.init(tabId, provider, connection, cwd, initScript);

    const prefs = projects[projectIndex]?.config.agentPrefs?.[provider];
    if (!prefs) return;
    const updates: Partial<typeof agentState> = {};
    if (prefs.model) {
      updates.model = prefs.model;
      window.shelfApi.agent.setModel(tabId, prefs.model);
    }
    if (prefs.effort) {
      updates.currentEffort = prefs.effort;
      window.shelfApi.agent.setEffort(tabId, prefs.effort);
    }
    if (prefs.permissionMode) {
      updates.permissionMode = prefs.permissionMode;
      window.shelfApi.agent.setMode(tabId, prefs.permissionMode);
    }
    if (Object.keys(updates).length > 0) updateAgentState(tabId, updates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, tabId, cwd, connection, initScript, projectIndex]);

  // Load history into store on first mount
  const historyLoaded = useRef(false);
  useEffect(() => {
    if (!provider || historyLoaded.current || messages.length > 0) return;
    historyLoaded.current = true;
    loadMessages(projectId).then((persisted) => {
      if (persisted.length === 0) return;
      const msgs: AgentMsg[] = [];
      const toolUseMap = new Map<string, AgentMsg>();
      for (const m of persisted) {
        if (m.type === 'tool_result' && m.toolUseId) {
          const tu = toolUseMap.get(m.toolUseId);
          if (tu) tu.toolResult = m.content;
          continue;
        }
        const msg: AgentMsg = {
          id: `hist-${Date.now()}-${msgs.length}`, role: m.role, type: m.type, content: m.content,
          provider: m.provider, toolName: m.toolName, toolUseId: m.toolUseId,
          toolInput: m.toolInput ? JSON.parse(m.toolInput) : undefined, cwd,
        };
        msgs.push(msg);
        if (m.type === 'tool_use' && m.toolUseId) toolUseMap.set(m.toolUseId, msg);
      }
      updateAgentState(tabId, { messages: msgs });
    });
  }, [provider, projectId, tabId, cwd, messages.length]);

  // Reset scroll restore flag when visibility changes
  useEffect(() => {
    if (visible && provider) {
      scrollRestoredRef.current = false;
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [visible, provider]);

  // Restore scroll position when becoming visible with messages
  useEffect(() => {
    if (!visible || messages.length === 0 || scrollRestoredRef.current) return;
    scrollRestoredRef.current = true;
    const savedTop = agentState.scrollTop;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) {
        el.scrollTop = savedTop !== null ? savedTop : el.scrollHeight;
        isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, messages.length]);

  // Save scroll position to store on scroll — re-bind when visible changes
  useEffect(() => {
    if (!visible) return;
    const el = listRef.current;
    if (!el) return;
    const handleScroll = () => {
      isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      updateAgentState(tabId, { scrollTop: el.scrollTop });
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [tabId, visible]);

  // Auto-scroll when at bottom (streaming updates), skip until scroll restored
  useEffect(() => {
    if (scrollRestoredRef.current && isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // Force scroll on user message send
  useEffect(() => {
    const prev = prevMessageCount.current;
    prevMessageCount.current = messages.length;
    if (messages.length > prev && messages[messages.length - 1]?.role === 'user') {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        isAtBottomRef.current = true;
      });
    }
  }, [messages.length]);

  useEffect(() => { setPermSelection(0); }, [pendingPermission?.toolUseId]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !provider) return;

    if (text === '/model') {
      setInput('');
      if (capabilities && capabilities.models.length > 0) {
        const currentIdx = capabilities.models.findIndex((m) => m.value === model);
        setModelPicker({ open: true, selected: currentIdx >= 0 ? currentIdx : 0 });
      }
      return;
    }

    setInput('');

    if (streaming) {
      updateAgentState(tabId, {
        queuedMessages: [...agentState.queuedMessages, { id: `q-${Date.now()}`, content: text }],
      });
      return;
    }

    addAgentMessage(tabId, { id: `msg-${Date.now()}`, role: 'user', type: 'text', content: text });
    saveMessage({ projectId, timestamp: Date.now(), role: 'user', type: 'text', content: text, provider });
    window.shelfApi.agent.send(tabId, text, cwd, provider, connection, initScript);
  }, [input, streaming, provider, tabId, projectId, cwd, connection, initScript, agentState]);

  const handleCancelQueued = useCallback((id: string) => {
    updateAgentState(tabId, {
      queuedMessages: agentState.queuedMessages.filter((q) => q.id !== id),
    });
  }, [tabId, agentState]);

  const handleStop = useCallback(() => {
    updateAgentState(tabId, { queuedMessages: [] });
    window.shelfApi.agent.stop(tabId);
  }, [tabId]);

  const handlePermissionRespond = useCallback((index: number) => {
    if (!pendingPermission) return;
    const scope: 'once' | 'session' | 'deny' = index === 0 ? 'once' : index === 1 ? 'session' : 'deny';
    window.shelfApi.agent.resolvePermission(tabId, pendingPermission.toolUseId, scope, pendingPermission.toolName, pendingPermission.input);
    updateAgentState(tabId, { pendingPermission: null });
  }, [tabId, pendingPermission]);

  useEffect(() => {
    if (!pendingPermission) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); setPermSelection((p) => (p > 0 ? p - 1 : 2)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setPermSelection((p) => (p < 2 ? p + 1 : 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); handlePermissionRespond(permSelection); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pendingPermission, permSelection, handlePermissionRespond]);

  const handleModelPickerSelect = useCallback((idx: number) => {
    if (!capabilities) return;
    const picked = capabilities.models[idx];
    if (!picked) return;
    updateAgentState(tabId, { model: picked.value });
    window.shelfApi.agent.setModel(tabId, picked.value);
    persistAgentPref('model', picked.value);
    setModelPicker({ open: false, selected: 0 });
  }, [tabId, capabilities, persistAgentPref]);

  useEffect(() => {
    if (!modelPicker.open || !capabilities) return;
    const max = capabilities.models.length - 1;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); setModelPicker((p) => ({ ...p, selected: p.selected > 0 ? p.selected - 1 : max })); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setModelPicker((p) => ({ ...p, selected: p.selected < max ? p.selected + 1 : 0 })); }
      else if (e.key === 'Enter') { e.preventDefault(); handleModelPickerSelect(modelPicker.selected); }
      else if (e.key === 'Escape') { e.preventDefault(); setModelPicker({ open: false, selected: 0 }); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [modelPicker.open, modelPicker.selected, capabilities, handleModelPickerSelect]);

  const handleCycleModel = useCallback(() => {
    if (!capabilities || capabilities.models.length === 0) return;
    const idx = capabilities.models.findIndex((m) => m.value === model);
    const next = capabilities.models[(idx + 1) % capabilities.models.length];
    updateAgentState(tabId, { model: next.value });
    window.shelfApi.agent.setModel(tabId, next.value);
    persistAgentPref('model', next.value);
  }, [tabId, capabilities, model, persistAgentPref]);

  const handleCycleMode = useCallback(() => {
    if (!capabilities || capabilities.permissionModes.length === 0) return;
    const idx = capabilities.permissionModes.indexOf(permissionMode);
    const next = capabilities.permissionModes[(idx + 1) % capabilities.permissionModes.length];
    updateAgentState(tabId, { permissionMode: next });
    window.shelfApi.agent.setMode(tabId, next);
    persistAgentPref('permissionMode', next);
  }, [tabId, capabilities, permissionMode, persistAgentPref]);

  const handleCycleEffort = useCallback(() => {
    if (!capabilities) return;
    const modelInfo = capabilities.models.find((m) => m.value === model);
    const levels = modelInfo?.effortLevels ?? capabilities.effortLevels;
    if (levels.length === 0) return;
    const idx = levels.indexOf(currentEffort);
    const next = levels[(idx + 1) % levels.length];
    updateAgentState(tabId, { currentEffort: next });
    window.shelfApi.agent.setEffort(tabId, next);
    persistAgentPref('effort', next);
  }, [tabId, capabilities, currentEffort, model, persistAgentPref]);

  const handleSwitchProvider = useCallback(async (newProvider: AgentProvider) => {
    if (newProvider === provider || streaming) return;
    const confirmed = await window.shelfApi.dialog.confirm(
      `Switch to ${newProvider.charAt(0).toUpperCase() + newProvider.slice(1)}`,
      `Current session will be paused and can be resumed later.\nContext will not transfer between providers.`,
      'Switch',
    );
    if (!confirmed) return;
    await window.shelfApi.agent.switchProvider(tabId, newProvider, connection, initScript);
    addAgentMessage(tabId, {
      id: `msg-${Date.now()}`, role: 'system', type: 'system',
      content: `── Switched to ${newProvider.charAt(0).toUpperCase() + newProvider.slice(1)} ──`,
    });
    updateAgentState(tabId, { model: undefined, cost: undefined, tokens: { input: 0, output: 0 }, rateLimit: null, contextInfo: null, slashCommands: [], capabilities: null });
    onSelectProvider(tabId, newProvider);
  }, [tabId, provider, connection, initScript, streaming, onSelectProvider]);

  const handleReset = useCallback(async () => {
    await window.shelfApi.agent.destroy(tabId);
    await clearMessages(projectId);
    deleteAgentState(tabId);
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
    if (e.key === 'Tab' && showSlashMenu) {
      e.preventDefault();
      const filtered = slashCommands.filter((c) => c.name.toLowerCase().includes(slashFilter));
      if (filtered.length > 0) handleSlashSelect(filtered[0].name);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showSlashMenu) {
        const filtered = slashCommands.filter((c) => c.name.toLowerCase().includes(slashFilter));
        if (filtered.length > 0) { handleSlashSelect(filtered[0].name); return; }
      }
      handleSend();
    }
    if (e.key === 'Escape') {
      if (showSlashMenu) { setShowSlashMenu(false); return; }
      if (streaming) { e.preventDefault(); handleStop(); }
    }
  }, [handleSend, handleStop, streaming, showSlashMenu, slashFilter, slashCommands, handleSlashSelect]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }
  }, [input]);

  if (!visible) return null;

  if (!provider) {
    return (
      <div className="agent-view">
        <div className="agent-provider-picker">
          <span className="agent-picker-title">Select Agent Provider</span>
          <div className="agent-picker-options">
            {AGENT_PROVIDERS.map((p) => (
              <button key={p.id} className="agent-picker-btn" onClick={() => onSelectProvider(tabId, p.id)}>{p.label}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (authRequired) {
    const retry = async () => {
      updateAgentState(tabId, { authBusy: true, authError: null });
      const { authenticated } = await window.shelfApi.copilotAuth.recheck();
      if (authenticated) {
        updateAgentState(tabId, { authRequired: null, authError: null, authBusy: false });
      } else {
        updateAgentState(tabId, { authError: 'Still no valid Copilot credentials found.', authBusy: false });
      }
    };
    return (
      <div className="agent-view agent-view-active">
        <div className="agent-auth-pane">
          <div className="agent-auth-title">GitHub Copilot not authenticated</div>
          <div className="agent-auth-instructions">
            Run one of the following in a terminal, then click Retry:
          </div>
          <ul className="agent-auth-list">
            <li><code>gh auth login -s copilot</code> — first time signing in with <code>gh</code></li>
            <li><code>gh auth refresh -h github.com -s copilot</code> — already signed in, just add Copilot scope</li>
            <li><code>copilot</code> — launch GitHub Copilot CLI and sign in</li>
          </ul>
          <button className="conn-btn conn-btn-next" disabled={authBusy} onClick={retry}>
            {authBusy ? 'Checking…' : 'Retry'}
          </button>
          {authError && <div className="agent-auth-error">{authError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-view agent-view-active">
      <div className="agent-messages" ref={listRef}>
        {messages.length === 0 && <div className="agent-empty">Send a message to start</div>}
        {(() => {
          const turns: { user?: AgentMsg; agent: AgentMsg[] }[] = [];
          for (const msg of messages) {
            if (msg.role === 'user') { turns.push({ user: msg, agent: [] }); }
            else if (turns.length === 0) { turns.push({ agent: [msg] }); }
            else { turns[turns.length - 1].agent.push(msg); }
          }
          return turns.map((turn, ti) => (
            <div key={turn.user?.id ?? `turn-${ti}`} className="agent-turn">
              {turn.user && <AgentMessage message={turn.user} />}
              {turn.agent.length > 0 && (
                <div className="agent-turn-response">
                  {turn.agent.map((msg) => <AgentMessage key={msg.id} message={msg} />)}
                </div>
              )}
            </div>
          ));
        })()}
        {streaming && messages.length > 0 && messages[messages.length - 1]?.role === 'user' && (
          <div className="agent-loading">
            <span className="agent-loading-spinner" />
            <span className="agent-loading-text">Agent is running... (Esc to stop)</span>
          </div>
        )}
        {queuedMessages.map((q) => (
          <div key={q.id} className="agent-msg agent-msg-user agent-msg-queued">
            <div className="agent-msg-content">{q.content}</div>
            <span className="agent-queued-label">queued</span>
            <button className="agent-queued-cancel" onClick={() => handleCancelQueued(q.id)} title="Cancel">×</button>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {pendingPermission && (
        <div className="agent-permission">
          <div className="agent-permission-header">Allow {pendingPermission.toolName}?</div>
          <div className="agent-perm-options">
            {['Allow', 'Allow (this session)', 'Deny'].map((label, i) => (
              <div key={label} className={`agent-perm-option agent-perm-option-${i < 2 ? 'allow' : 'deny'}${permSelection === i ? ' selected' : ''}`} onClick={() => handlePermissionRespond(i)}>
                <span className="agent-perm-indicator">{permSelection === i ? '\u25b6' : ' '}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="agent-perm-hint"><kbd>&uarr;</kbd><kbd>&darr;</kbd> select &nbsp; <kbd>Enter</kbd> confirm</div>
        </div>
      )}

      {modelPicker.open && capabilities && capabilities.models.length > 0 && (
        <div className="agent-permission">
          <div className="agent-permission-header">Select model</div>
          <div className="agent-perm-options">
            {capabilities.models.map((m, i) => (
              <div key={m.value} className={`agent-perm-option agent-perm-option-allow${modelPicker.selected === i ? ' selected' : ''}`} onClick={() => handleModelPickerSelect(i)}>
                <span className="agent-perm-indicator">{modelPicker.selected === i ? '\u25b6' : ' '}</span>
                <span>{m.displayName}{m.value === model ? ' (current)' : ''}</span>
              </div>
            ))}
          </div>
          <div className="agent-perm-hint"><kbd>&uarr;</kbd><kbd>&darr;</kbd> select &nbsp; <kbd>Enter</kbd> confirm &nbsp; <kbd>Esc</kbd> cancel</div>
        </div>
      )}

      {showSlashMenu && slashCommands.length > 0 && (() => {
        const filtered = slashCommands.filter((c) => c.name.toLowerCase().includes(slashFilter));
        if (filtered.length === 0) return null;
        return (
          <div className="agent-slash-menu">
            {filtered.slice(0, 10).map((cmd) => (
              <button key={cmd.name} className="agent-slash-item" onMouseDown={(e) => { e.preventDefault(); handleSlashSelect(cmd.name); }}>
                <span className="agent-slash-name">/{cmd.name}</span>
                <span className="agent-slash-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        );
      })()}

      <div className="agent-input-area">
        <span className="agent-prompt">❯</span>
        <textarea ref={textareaRef} className="agent-textarea" value={input} onChange={handleInputChange} onKeyDown={handleKeyDown} placeholder="Message..." rows={1} />
        <div className="agent-input-actions">
          {streaming
            ? <button className="agent-btn agent-btn-stop" onClick={handleStop}>Stop</button>
            : <button className="agent-btn agent-btn-send" onClick={handleSend} disabled={!input.trim()}>Send</button>}
        </div>
      </div>

      <div className="agent-status-bar">
        <span className="agent-status-dot" style={{ color: agentStatus === 'running' ? '#e5c07b' : '#98c379' }}>{'\u25CF'}</span>
        <span className="agent-status-label">{agentStatus}</span>
        <span className="agent-status-sep">|</span>
        <select className="agent-provider-switch" value={provider} onChange={(e) => handleSwitchProvider(e.target.value as AgentProvider)} disabled={streaming}>
          {AGENT_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {model && <><span className="agent-status-sep">|</span><span className={`agent-status-seg ${capabilities ? 'agent-status-interactive' : ''}`} onClick={handleCycleModel}>{model}</span></>}
        {capabilities && capabilities.permissionModes.length > 0 && (
          <><span className="agent-status-sep">|</span><span className="agent-status-seg agent-status-interactive" style={{ color: permissionMode === 'bypassPermissions' ? '#e06c75' : permissionMode === 'acceptEdits' ? '#e5c07b' : permissionMode === 'plan' ? '#61afef' : undefined }} onClick={handleCycleMode}>{permissionMode === 'default' ? 'ask' : permissionMode}</span></>
        )}
        {(() => {
          const modelInfo = capabilities?.models.find((m) => m.value === model);
          const levels = modelInfo?.effortLevels ?? capabilities?.effortLevels ?? [];
          if (levels.length === 0) return null;
          return <><span className="agent-status-sep">|</span><span className="agent-status-seg agent-status-interactive" onClick={handleCycleEffort}><span className="agent-status-seg-label">effort: </span>{currentEffort}</span></>;
        })()}
        {contextInfo && contextInfo.window > 0 && (() => {
          const ratio = contextInfo.used / contextInfo.window;
          const color = ratio >= 0.8 ? '#e06c75' : ratio >= 0.5 ? '#e5c07b' : undefined;
          return <><span className="agent-status-sep">|</span><span className="agent-status-seg" style={color ? { color } : undefined}><span className="agent-status-seg-label">ctx: </span>{Math.round(ratio * 100)}%</span></>;
        })()}
        {(tokens.input > 0 || tokens.output > 0) && <><span className="agent-status-sep">|</span><span className="agent-status-seg">{Math.round(tokens.input / 1000)}k+{Math.round(tokens.output / 1000)}k</span></>}
        {cost !== undefined && <><span className="agent-status-sep">|</span><span className="agent-status-seg">${cost.toFixed(3)}</span></>}
        {rateLimit?.utilization !== undefined && (
          <><span className="agent-status-sep">|</span><span className="agent-status-seg" style={{ color: rateLimit.utilization > 0.8 ? '#e06c75' : rateLimit.utilization > 0.5 ? '#e5c07b' : undefined }}>
            {rateLimit.type === 'five_hour' ? '5h' : rateLimit.type === 'seven_day' ? '7d' : rateLimit.type ?? ''}: {Math.round(rateLimit.utilization * 100)}%
            {rateLimit.resetsAt && (() => { const d = rateLimit.resetsAt! - Date.now(); return d > 0 ? <span> ↻{d >= 3600000 ? `${(d / 3600000).toFixed(1)}h` : `${Math.ceil(d / 60000)}m`}</span> : null; })()}
          </span></>
        )}
        <span style={{ marginLeft: 'auto' }} />
        <button className="agent-reset-btn" onClick={handleReset} disabled={streaming} title="Reset session">Reset</button>
      </div>
    </div>
  );
}
