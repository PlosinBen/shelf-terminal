import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { AgentProvider, AuthMethod, Connection } from '@shared/types';
import { AgentMessage, type AgentMsg } from './AgentMessage';
import { useAttachmentPaste } from '../hooks/useAttachmentPaste';

const AGENT_PROVIDERS: { id: AgentProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'copilot', label: 'Copilot' },
];

interface SlashCommand {
  name: string;
  description: string;
}

interface Capabilities {
  models: { value: string; displayName: string; effortLevels?: string[]; vision?: boolean }[];
  permissionModes: string[];
  effortLevels: string[];
  slashCommands: SlashCommand[];
  authMethod?: AuthMethod;
}

interface PendingPermission {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface QueuedMessage {
  id: string;
  content: string;
}

interface Props {
  tabId: string;
  cwd: string;
  connection: Connection;
  provider: AgentProvider;
  onSwitchProvider?: (tabId: string, provider: AgentProvider) => void;
}

export function AgentView({ tabId, cwd, connection, provider, onSwitchProvider }: Props) {
  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamThinking, setStreamThinking] = useState('');
  const [statusModel, setStatusModel] = useState<string | null>(null);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [costUsd, setCostUsd] = useState<number | undefined>(undefined);
  const [numTurns, setNumTurns] = useState<number | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [permissionMode, setPermissionMode] = useState<string>('default');
  const [currentEffort, setCurrentEffort] = useState<string>('medium');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelection, setSlashSelection] = useState(0);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [permSelection, setPermSelection] = useState(0);
  const [modelPicker, setModelPicker] = useState<{ open: boolean; selected: number }>({ open: false, selected: 0 });
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [authRequired, setAuthRequired] = useState<{ provider: string } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<Array<{ path: string; displayPath: string }>>([]);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [escPending, setEscPending] = useState(false);
  const escPendingRef = useRef(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const isAtBottomRef = useRef(true);

  // Attachment paste support
  useAttachmentPaste(rootRef, {
    connection,
    cwd,
    maxUploadSizeMB: 50,
    onUpload: (uploads) => {
      setPendingFiles((prev) => [
        ...prev,
        ...uploads.map((u) => ({ path: u.remotePath, displayPath: u.displayPath })),
      ]);
    },
    onImages: (urls) => {
      const currentModel = capabilities?.models.find((m) => m.value === statusModel);
      if (currentModel && currentModel.vision === false) {
        window.shelfApi.dialog.warn('Images not supported', `The current model does not accept image input.`);
        return;
      }
      const accepted = urls.filter((u) => u.length < 20 * 1024 * 1024);
      if (accepted.length < urls.length) {
        window.shelfApi.dialog.warn('Image too large', 'Images over ~20MB were skipped.');
      }
      if (accepted.length > 0) setPendingImages((prev) => [...prev, ...accepted]);
    },
  });

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    window.shelfApi.agent.init(tabId, cwd, connection, provider);
  }, [tabId, cwd, connection, provider]);

  // Capabilities listener
  useEffect(() => {
    const off = window.shelfApi.agent.onCapabilities((id: string, caps: any) => {
      if (id !== tabId) return;
      setCapabilities(caps);
      if (caps.currentModel) setStatusModel(caps.currentModel);
      if (caps.currentPermissionMode) setPermissionMode(caps.currentPermissionMode);
      if (caps.currentEffort) setCurrentEffort(caps.currentEffort);
    });
    return off;
  }, [tabId]);

  // Permission request listener
  useEffect(() => {
    const off = window.shelfApi.agent.onPermissionRequest((id: string, req: any) => {
      if (id !== tabId) return;
      setPendingPermission({ toolUseId: req.toolUseId, toolName: req.toolName, input: req.input ?? {} });
      setPermSelection(0);
    });
    return off;
  }, [tabId]);

  // Auth required listener
  useEffect(() => {
    const off = window.shelfApi.agent.onAuthRequired((id: string, prov: string) => {
      if (id !== tabId) return;
      setAuthRequired({ provider: prov });
    });
    return off;
  }, [tabId]);

  // Messages, stream, and status listeners
  useEffect(() => {
    const offMessage = window.shelfApi.agent.onMessage((id: string, msg: any) => {
      if (id !== tabId) return;
      if (msg.type === 'error') {
        setMessages((prev) => [...prev, {
          id: `err-${Date.now()}`, type: 'error', content: msg.content, timestamp: Date.now(),
        }]);
        return;
      }
      if (msg.type === 'result') return;

      const newMsg: AgentMsg = {
        id: `msg-${Date.now()}-${Math.random()}`,
        type: msg.type === 'tool_use' ? 'tool_use' : msg.type === 'tool_result' ? 'tool_result' : msg.type === 'text' ? 'assistant' : msg.type === 'thinking' ? 'thinking' : 'system',
        content: msg.content,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        toolUseId: msg.toolUseId,
        provider,
        timestamp: Date.now(),
      };

      // Attach tool_result to its matching tool_use
      if (msg.type === 'tool_result' && msg.toolUseId) {
        setMessages((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].type === 'tool_use' && updated[i].toolUseId === msg.toolUseId) {
              updated[i] = { ...updated[i], toolResult: msg.content };
              return updated;
            }
          }
          return [...prev, newMsg];
        });
        return;
      }

      setMessages((prev) => [...prev, newMsg]);
    });

    const offStream = window.shelfApi.agent.onStream((id: string, chunk: any) => {
      if (id !== tabId) return;
      if (chunk.type === 'thinking') {
        setStreamThinking((prev) => prev + (chunk.content ?? ''));
      } else {
        setStreamText((prev) => prev + (chunk.content ?? ''));
      }
    });

    const offStatus = window.shelfApi.agent.onStatus((id: string, status: any) => {
      if (id !== tabId) return;
      const nowStreaming = status.state === 'streaming';
      setIsStreaming((wasStreaming) => {
        if (wasStreaming && !nowStreaming) {
          setStreamThinking((prevThinking) => {
            if (prevThinking.trim()) {
              setMessages((msgs) => [...msgs, {
                id: `thinking-${Date.now()}`, type: 'thinking', content: prevThinking, provider, timestamp: Date.now(),
              }]);
            }
            return '';
          });
          setStreamText((prev) => {
            if (prev.trim()) {
              setMessages((msgs) => [...msgs, {
                id: `stream-${Date.now()}`, type: 'assistant', content: prev, provider, timestamp: Date.now(),
              }]);
            }
            return '';
          });
          // Flush queued messages
          setQueuedMessages((queue) => {
            if (queue.length > 0) {
              const next = queue[0];
              setTimeout(() => window.shelfApi.agent.send(tabId, next.content), 50);
              return queue.slice(1);
            }
            return queue;
          });
        }
        return nowStreaming;
      });
      if (status.model) setStatusModel(status.model);
      if (status.inputTokens != null) setInputTokens(status.inputTokens);
      if (status.outputTokens != null) setOutputTokens(status.outputTokens);
      if (status.costUsd != null) setCostUsd(status.costUsd);
      if (status.numTurns != null) setNumTurns(status.numTurns);
    });

    return () => { offMessage(); offStream(); offStatus(); };
  }, [tabId, provider]);

  // Scroll management
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const handleScroll = () => {
      isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamText, streamThinking]);

  // Force scroll on user message
  const prevCount = useRef(0);
  useEffect(() => {
    if (messages.length > prevCount.current && messages[messages.length - 1]?.type === 'user') {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        isAtBottomRef.current = true;
      });
    }
    prevCount.current = messages.length;
  }, [messages.length]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if ((!text && pendingFiles.length === 0 && pendingImages.length === 0)) return;

    // /model command interception
    if (text === '/model' || text.startsWith('/model ')) {
      setInput('');
      const arg = text.slice('/model'.length).trim();
      if (!arg) {
        if (capabilities && capabilities.models.length > 0) {
          const idx = capabilities.models.findIndex((m) => m.value === statusModel);
          setModelPicker({ open: true, selected: idx >= 0 ? idx : 0 });
        }
        return;
      }
      const match = capabilities?.models.find((m) => m.value === arg);
      if (!match) {
        setMessages((prev) => [...prev, {
          id: `msg-${Date.now()}`, type: 'error', content: `Unknown model: ${arg}`, timestamp: Date.now(),
        }]);
        return;
      }
      setStatusModel(arg);
      window.shelfApi.agent.setPrefs(tabId, { model: arg });
      setMessages((prev) => [...prev, {
        id: `msg-${Date.now()}`, type: 'system', content: `── Model switched to ${match.displayName} ──`, timestamp: Date.now(),
      }]);
      return;
    }

    const files = pendingFiles;
    const images = pendingImages;
    setInput('');
    setPendingFiles([]);
    setPendingImages([]);
    setShowSlashMenu(false);

    if (isStreaming) {
      setQueuedMessages((q) => [...q, { id: `q-${Date.now()}`, content: text }]);
      return;
    }

    setMessages((prev) => [...prev, {
      id: `user-${Date.now()}`, type: 'user', content: text, timestamp: Date.now(),
      ...(files.length > 0 || images.length > 0 ? {} : {}),
    }]);
    setStreamText('');
    window.shelfApi.agent.send(tabId, text, images.length > 0 ? images : undefined);
  }, [tabId, input, isStreaming, pendingFiles, pendingImages, capabilities, statusModel]);

  const handleStop = useCallback(() => {
    setQueuedMessages([]);
    window.shelfApi.agent.stop(tabId);
  }, [tabId]);

  const handleCancelQueued = useCallback((id: string) => {
    setQueuedMessages((q) => q.filter((m) => m.id !== id));
  }, []);

  // Permission response
  const handlePermissionRespond = useCallback((allow: boolean) => {
    if (!pendingPermission) return;
    window.shelfApi.agent.resolvePermission(tabId, pendingPermission.toolUseId, allow);
    setPendingPermission(null);
  }, [tabId, pendingPermission]);

  useEffect(() => {
    if (!pendingPermission) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); setPermSelection((p) => (p > 0 ? p - 1 : 1)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setPermSelection((p) => (p < 1 ? p + 1 : 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); handlePermissionRespond(permSelection === 0); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pendingPermission, permSelection, handlePermissionRespond]);

  // Model picker keyboard
  const handleModelPickerSelect = useCallback((idx: number) => {
    if (!capabilities) return;
    const picked = capabilities.models[idx];
    if (!picked) return;
    setStatusModel(picked.value);
    window.shelfApi.agent.setPrefs(tabId, { model: picked.value });
    setMessages((prev) => [...prev, {
      id: `msg-${Date.now()}`, type: 'system', content: `── Model switched to ${picked.displayName} ──`, timestamp: Date.now(),
    }]);
    setModelPicker({ open: false, selected: 0 });
  }, [tabId, capabilities]);

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

  // Status bar cycling
  const handleCycleModel = useCallback(() => {
    if (!capabilities || capabilities.models.length === 0) return;
    const idx = capabilities.models.findIndex((m) => m.value === statusModel);
    const next = capabilities.models[(idx + 1) % capabilities.models.length];
    setStatusModel(next.value);
    window.shelfApi.agent.setPrefs(tabId, { model: next.value });
  }, [tabId, capabilities, statusModel]);

  const handleCycleMode = useCallback(() => {
    if (!capabilities || capabilities.permissionModes.length === 0) return;
    const idx = capabilities.permissionModes.indexOf(permissionMode);
    const next = capabilities.permissionModes[(idx + 1) % capabilities.permissionModes.length];
    setPermissionMode(next);
    window.shelfApi.agent.setPrefs(tabId, { permissionMode: next });
  }, [tabId, capabilities, permissionMode]);

  const handleCycleEffort = useCallback(() => {
    if (!capabilities || capabilities.effortLevels.length === 0) return;
    const idx = capabilities.effortLevels.indexOf(currentEffort);
    const next = capabilities.effortLevels[(idx + 1) % capabilities.effortLevels.length];
    setCurrentEffort(next);
    window.shelfApi.agent.setPrefs(tabId, { effort: next });
  }, [tabId, capabilities, currentEffort]);

  const handleSwitchProvider = useCallback(async (newProvider: AgentProvider) => {
    if (newProvider === provider || isStreaming) return;
    const confirmed = await window.shelfApi.dialog.confirm(
      `Switch to ${newProvider.charAt(0).toUpperCase() + newProvider.slice(1)}`,
      'Current session will be paused. Context will not transfer between providers.',
      'Switch',
    );
    if (!confirmed) return;
    await window.shelfApi.agent.switchProvider(tabId, newProvider);
    setMessages((prev) => [...prev, {
      id: `msg-${Date.now()}`, type: 'system', content: `── Switched to ${newProvider.charAt(0).toUpperCase() + newProvider.slice(1)} ──`, timestamp: Date.now(),
    }]);
    setStatusModel(null);
    setCostUsd(undefined);
    setInputTokens(0);
    setOutputTokens(0);
    setCapabilities(null);
    onSwitchProvider?.(tabId, newProvider);
  }, [tabId, provider, isStreaming, onSwitchProvider]);

  const handleReset = useCallback(async () => {
    await window.shelfApi.agent.destroy(tabId);
    setMessages([]);
    setStreamText('');
    setCostUsd(undefined);
    setInputTokens(0);
    setOutputTokens(0);
    setNumTurns(undefined);
    initializedRef.current = false;
    window.shelfApi.agent.init(tabId, cwd, connection, provider);
    initializedRef.current = true;
  }, [tabId, cwd, connection, provider]);

  // Slash menu
  const filteredCommands = useMemo(() => {
    return capabilities?.slashCommands.filter(
      (cmd) => !slashFilter || cmd.name.includes(slashFilter) || cmd.description.toLowerCase().includes(slashFilter.toLowerCase()),
    ) ?? [];
  }, [capabilities, slashFilter]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    if (val.startsWith('/') && !val.includes('\n')) {
      setSlashFilter(val.slice(1).split(/\s/)[0]);
      setShowSlashMenu(true);
      setSlashSelection(0);
    } else {
      setShowSlashMenu(false);
    }
  };

  const handleSlashSelect = (cmd: SlashCommand) => {
    setInput(`/${cmd.name} `);
    setShowSlashMenu(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (showSlashMenu && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelection((s) => Math.min(s + 1, filteredCommands.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelection((s) => Math.max(s - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        handleSlashSelect(filteredCommands[slashSelection]);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape') {
      if (showSlashMenu) { setShowSlashMenu(false); return; }
      if (isStreaming) {
        e.preventDefault();
        if (escPendingRef.current) {
          if (escTimerRef.current) { clearTimeout(escTimerRef.current); escTimerRef.current = null; }
          escPendingRef.current = false;
          setEscPending(false);
          handleStop();
        } else {
          escPendingRef.current = true;
          setEscPending(true);
          escTimerRef.current = setTimeout(() => { escPendingRef.current = false; setEscPending(false); escTimerRef.current = null; }, 1500);
        }
      }
    }
  };

  useEffect(() => {
    if (isStreaming) return;
    escPendingRef.current = false;
    setEscPending(false);
    if (escTimerRef.current) { clearTimeout(escTimerRef.current); escTimerRef.current = null; }
  }, [isStreaming]);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }
  }, [input]);

  // Turn-based grouping
  const turns = useMemo(() => {
    const result: { user?: AgentMsg; agent: AgentMsg[] }[] = [];
    for (const msg of messages) {
      if (msg.type === 'user') { result.push({ user: msg, agent: [] }); }
      else if (result.length === 0) { result.push({ agent: [msg] }); }
      else { result[result.length - 1].agent.push(msg); }
    }
    return result;
  }, [messages]);

  const modeColor = permissionMode === 'bypassPermissions' ? '#e06c75' : permissionMode === 'acceptEdits' ? '#e5c07b' : permissionMode === 'plan' ? '#61afef' : undefined;

  // Auth required screen
  if (authRequired) {
    const authMethod = capabilities?.authMethod;
    const providerLabel = authRequired.provider.charAt(0).toUpperCase() + authRequired.provider.slice(1);

    const retry = async () => {
      setAuthBusy(true);
      setAuthError(null);
      const result = await window.shelfApi.agent.checkAuth(tabId);
      if (result) {
        setAuthRequired(null);
        setAuthError(null);
      } else {
        setAuthError('Still no valid credentials found.');
      }
      setAuthBusy(false);
    };

    return (
      <div className="agent-view" ref={rootRef}>
        <div className="agent-auth-pane">
          <div className="agent-auth-title">
            {authMethod?.kind === 'api-key' ? `${providerLabel} API key missing` :
             authMethod?.kind === 'sdk-managed' ? `${providerLabel} SDK not signed in` :
             `${providerLabel} not authenticated`}
          </div>
          {authMethod?.kind === 'api-key' && (
            <div className="agent-auth-instructions">
              {providerLabel} needs an API key.
              {authMethod.setupUrl && <> Get one at <code>{authMethod.setupUrl}</code>.</>}
            </div>
          )}
          {(authMethod?.kind === 'sdk-managed' || authMethod?.kind === 'oauth') && (
            <>
              <div className="agent-auth-instructions">Run the following, then click Retry:</div>
              <ul className="agent-auth-list">
                {authMethod.instructions.map((ins, i) => (
                  <li key={i}>{ins.command && <code>{ins.command}</code>}{ins.label && ` — ${ins.label}`}</li>
                ))}
              </ul>
            </>
          )}
          <button className="agent-reset-btn" disabled={authBusy} onClick={retry}>
            {authBusy ? 'Checking…' : 'Retry'}
          </button>
          {authError && <div className="agent-auth-error">{authError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-view" ref={rootRef}>
      <div className="agent-messages" ref={listRef}>
        {messages.length === 0 && !isStreaming && <div className="agent-empty">Send a message to start</div>}
        {turns.map((turn, ti) => (
          <div key={turn.user?.id ?? `turn-${ti}`} className="agent-turn">
            {turn.user && <AgentMessage message={turn.user} cwd={cwd} />}
            {turn.agent.length > 0 && (
              <div className="agent-turn-response">
                {turn.agent.map((msg) => <AgentMessage key={msg.id} message={msg} cwd={cwd} />)}
              </div>
            )}
          </div>
        ))}
        {streamThinking && (
          <div className="agent-msg agent-msg-thinking">
            <div className="agent-thinking-header">
              <span className="agent-thinking-label">Thinking...</span>
            </div>
          </div>
        )}
        {streamText && (
          <div className="agent-msg agent-msg-assistant">
            <span className="agent-msg-label">{provider.charAt(0).toUpperCase() + provider.slice(1)}:</span>
            <div className="agent-msg-content agent-markdown" dangerouslySetInnerHTML={{ __html: streamText }} />
            <span className="agent-cursor" />
          </div>
        )}
        {isStreaming && !streamText && messages.length > 0 && (
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
          <div className="agent-permission-header">Allow <strong>{pendingPermission.toolName}</strong>?</div>
          <pre className="agent-permission-input">{JSON.stringify(pendingPermission.input, null, 2)}</pre>
          <div className="agent-perm-options">
            {['Allow', 'Deny'].map((label, i) => (
              <div key={label} className={`agent-perm-option agent-perm-option-${i === 0 ? 'allow' : 'deny'}${permSelection === i ? ' selected' : ''}`} onClick={() => handlePermissionRespond(i === 0)}>
                <span className="agent-perm-indicator">{permSelection === i ? '▶' : ' '}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="agent-perm-hint"><kbd>↑</kbd><kbd>↓</kbd> select · <kbd>Enter</kbd> confirm</div>
        </div>
      )}

      {modelPicker.open && capabilities && capabilities.models.length > 0 && (
        <div className="agent-permission">
          <div className="agent-permission-header">Select model</div>
          <div className="agent-perm-options">
            {capabilities.models.map((m, i) => (
              <div key={m.value} className={`agent-perm-option agent-perm-option-allow${modelPicker.selected === i ? ' selected' : ''}`} onClick={() => handleModelPickerSelect(i)}>
                <span className="agent-perm-indicator">{modelPicker.selected === i ? '▶' : ' '}</span>
                <span>{m.displayName}{m.value === statusModel ? ' (current)' : ''}</span>
              </div>
            ))}
          </div>
          <div className="agent-perm-hint"><kbd>↑</kbd><kbd>↓</kbd> select · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel</div>
        </div>
      )}

      <div className="agent-input-area">
        {showSlashMenu && filteredCommands.length > 0 && (
          <div className="agent-slash-menu">
            {filteredCommands.slice(0, 10).map((cmd, i) => (
              <div
                key={cmd.name}
                className={`agent-slash-item${i === slashSelection ? ' agent-slash-item-selected' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); handleSlashSelect(cmd); }}
                onMouseEnter={() => setSlashSelection(i)}
              >
                <span className="agent-slash-name">/{cmd.name}</span>
                <span className="agent-slash-desc">{cmd.description}</span>
              </div>
            ))}
          </div>
        )}
        {(pendingFiles.length > 0 || pendingImages.length > 0) && (
          <div className="agent-attachment-row">
            {pendingImages.map((url, i) => (
              <span key={`img-${i}`} className="agent-attachment-chip">
                img {i + 1} ({Math.round(url.length * 3 / 4 / 1024)} KB)
                <button type="button" className="agent-attachment-remove" onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            {pendingFiles.map((f) => (
              <span key={f.path} className="agent-attachment-chip">
                {f.displayPath}
                <button type="button" className="agent-attachment-remove" onClick={() => setPendingFiles((prev) => prev.filter((p) => p.path !== f.path))}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="agent-input-row">
          <span className="agent-prompt">&#10095;</span>
          <textarea
            ref={inputRef}
            className="agent-textarea"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask something..."
            rows={1}
          />
          {escPending && <span className="agent-esc-hint">Press Esc again to stop</span>}
        </div>
      </div>

      <div className="agent-status-bar">
        <span className="agent-status-dot" style={{ color: isStreaming ? '#e5c07b' : '#98c379' }}>{'●'}</span>
        <span className="agent-status-label">{isStreaming ? 'running' : 'idle'}</span>
        <span className="agent-status-sep">|</span>
        <select className="agent-provider-switch" value={provider} onChange={(e) => handleSwitchProvider(e.target.value as AgentProvider)} disabled={isStreaming}>
          {AGENT_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {statusModel && (
          <>
            <span className="agent-status-sep">|</span>
            <span className={`agent-status-seg${capabilities ? ' agent-status-interactive' : ''}`} onClick={handleCycleModel}>{statusModel}</span>
          </>
        )}
        {capabilities && capabilities.permissionModes.length > 0 && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg agent-status-interactive" style={modeColor ? { color: modeColor } : undefined} onClick={handleCycleMode}>
              {permissionMode === 'default' ? 'ask' : permissionMode}
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
        {(inputTokens > 0 || outputTokens > 0) && <><span className="agent-status-sep">|</span><span className="agent-status-seg">{Math.round(inputTokens / 1000)}k+{Math.round(outputTokens / 1000)}k</span></>}
        {costUsd !== undefined && <><span className="agent-status-sep">|</span><span className="agent-status-seg">${costUsd.toFixed(3)}</span></>}
        {numTurns !== undefined && <><span className="agent-status-sep">|</span><span className="agent-status-seg">{numTurns} turns</span></>}
        <span style={{ marginLeft: 'auto' }} />
        <button className="agent-reset-btn" onClick={handleReset} disabled={isStreaming} title="Reset session">Reset</button>
      </div>
    </div>
  );
}
