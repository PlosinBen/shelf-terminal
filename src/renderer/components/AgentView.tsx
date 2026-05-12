import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { AgentProvider, AgentPrefs, AuthMethod, Connection } from '@shared/types';
import { AgentMessage, type AgentMsg } from './AgentMessage';
import { renderMarkdown } from '../utils/markdown';
import { useAttachmentPaste } from '../hooks/useAttachmentPaste';
import { useStore, updateProjectConfig, setChatStage } from '../store';
import { loadAgentMessages, saveAgentMessages, clearAgentSession } from '../storage/agent-history';

interface SlashCommand {
  name: string;
  description: string;
}

type Severity = 'normal' | 'info' | 'warning' | 'critical';
interface CycleOption {
  value: string;
  displayName: string;
  severity?: Severity;
}

interface Capabilities {
  models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[];
  permissionModes: CycleOption[];
  effortLevels: CycleOption[];
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
  projectIndex: number;
  visible: boolean;
}

let nextMsgIdCounter = 0;
function freshMsgId(prefix: string): string {
  nextMsgIdCounter += 1;
  return `${prefix}-${Date.now()}-${nextMsgIdCounter}`;
}

/**
 * Translate the canonical AgentMessage payload (from `@shared/types`) into the
 * renderer-side `AgentMsg` variant. Unknown / malformed payloads return null
 * so the caller can drop them. Provider field is attached when relevant for
 * the assistant-text label.
 */
function buildAgentMsg(msg: any, provider: string): AgentMsg | null {
  // `id` is the universal upsert key — equals `msg.msgId` from the wire
  // (which equals toolUseId for tool messages). Provider-minted; renderer
  // uses it both as React key and as the upsert key for the message store.
  // Fall back to a synthetic id for messages from older agent-server bundles
  // that don't emit msgId yet (won't pair with stream chunks but at least
  // gets a usable key).
  const id: string = msg.msgId ?? msg.toolUseId ?? freshMsgId('msg');
  const ts = Date.now();
  switch (msg.type) {
    case 'text':
      return { id, type: 'text', content: msg.content ?? '', provider, timestamp: ts };
    case 'thinking':
      return { id, type: 'thinking', content: msg.content ?? '', provider, timestamp: ts };
    case 'intent':
      return { id, type: 'intent', content: msg.content ?? '', provider, timestamp: ts };
    case 'system':
      return { id, type: 'system', content: msg.content ?? '', provider, timestamp: ts };
    case 'error':
      return { id, type: 'error', content: msg.content ?? 'Unknown error', provider, timestamp: ts };
    case 'tool_use':
      if (!msg.toolUseId || !msg.toolName) return null;
      return {
        id,
        type: 'tool_use',
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        // Provider sends `input: string`. Defensively coerce in case old
        // wire bundle still emits structured toolInput (older agent-server
        // version on remote SSH host that hasn't been redeployed).
        input: typeof msg.input === 'string'
          ? msg.input
          : msg.toolInput
            ? JSON.stringify(msg.toolInput)
            : '',
        ...(msg.result ? { result: msg.result } : {}),
        provider,
        timestamp: ts,
      };
    case 'file_edit':
      if (!msg.toolUseId || !msg.filePath) return null;
      return {
        id,
        type: 'file_edit',
        toolUseId: msg.toolUseId,
        filePath: msg.filePath,
        ...(msg.diff ? { diff: msg.diff } : {}),
        ...(typeof msg.content === 'string' ? { content: msg.content } : {}),
        ...(msg.result ? { result: msg.result } : {}),
        provider,
        timestamp: ts,
      };
    default:
      return null;
  }
}

/**
 * Insert `built` into the timeline OR replace the existing entry with the
 * same `id`. Stream chunks and their finalize message share an id; the
 * provider also re-emits tool_use/file_edit messages with `result` populated.
 * Either way, upsert-by-id collapses them into a single timeline entry.
 * `timestamp` is preserved from the original so ordering doesn't jump.
 */
function upsertById(prev: AgentMsg[], built: AgentMsg): AgentMsg[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].id === built.id) {
      const next = prev.slice();
      next[i] = { ...built, timestamp: prev[i].timestamp };
      return next;
    }
  }
  return [...prev, built];
}

export function AgentView({ tabId, cwd, connection, provider, projectIndex, visible }: Props) {
  const { projects, settings, chatStage } = useStore();
  const savedPrefs = projects[projectIndex]?.config.agentPrefs?.[provider];

  const sessionIdRef = useRef<string | null>(null);
  if (!sessionIdRef.current) {
    const existing = projects[projectIndex]?.config.agentSessionIds?.[provider];
    if (existing) {
      sessionIdRef.current = existing;
    } else {
      const newId = crypto.randomUUID();
      sessionIdRef.current = newId;
      const ids = { ...projects[projectIndex]?.config.agentSessionIds, [provider]: newId };
      updateProjectConfig(projectIndex, { agentSessionIds: ids });
    }
  }
  const sessionId = sessionIdRef.current;

  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [currentPlan, setCurrentPlan] = useState<string>('');
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusModel, setStatusModel] = useState<string | null>(savedPrefs?.model ?? null);
  const [costUsd, setCostUsd] = useState<number | undefined>(undefined);
  const [numTurns, setNumTurns] = useState<number | undefined>(undefined);
  type StatusSegment = { text: string; severity?: 'normal' | 'warning' | 'critical' };
  const [contextUsage, setContextUsage] = useState<StatusSegment | null>(null);
  const [rateLimits, setRateLimits] = useState<StatusSegment[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [permissionMode, setPermissionMode] = useState<string>(savedPrefs?.permissionMode ?? 'default');
  const [currentEffort, setCurrentEffort] = useState<string>(savedPrefs?.effort ?? 'medium');

  const persistPref = useCallback((partial: Partial<AgentPrefs>) => {
    const current = projects[projectIndex]?.config.agentPrefs ?? {};
    const updated = { ...current, [provider]: { ...current[provider], ...partial } };
    updateProjectConfig(projectIndex, { agentPrefs: updated });
  }, [projectIndex, provider, projects]);
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
  const [initStatus, setInitStatus] = useState<'starting' | 'ready' | 'failed'>('starting');
  const [initError, setInitError] = useState<string | null>(null);
  const [escPending, setEscPending] = useState(false);
  const escPendingRef = useRef(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  // User intent to "stick to the bottom of the conversation". Updated only
  // by user-driven scroll inputs (wheel/touch/keyboard); programmatic scrolls
  // (scrollIntoView from auto-follow) deliberately do NOT change this — they
  // honour intent, not geometric position. Decoupling intent from geometry
  // avoids the smooth-scroll mid-animation race that previously needed a
  // programmaticScrollRef + setTimeout workaround.
  //
  // The ref is the source of truth (read by effects without re-render); the
  // FAB visibility is its mirror as state (so React re-renders when it flips).
  // Always update them through `setFollow` so they can never drift.
  const followBottomRef = useRef(true);
  const [showJumpFab, setShowJumpFab] = useState(false);
  const setFollow = useCallback((follow: boolean) => {
    followBottomRef.current = follow;
    setShowJumpFab((prev) => (prev === !follow ? prev : !follow));
  }, []);

  // Focus the input whenever this tab becomes visible (tab switch, project
  // switch, app launch). requestAnimationFrame defers past the layout pass so
  // the textarea is actually in the visible DOM (parent is display:none → block).
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [visible]);

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
    window.shelfApi.agent.init(tabId, cwd, connection, provider, sessionId);
    // Saved prefs are reconciled in the capabilities listener below — that
    // fires on first launch *and* after every reconnect/reset, whereas this
    // effect only runs once. Single source of truth for the "renderer wants
    // X but a fresh backend defaults to Y" drift.
  }, [tabId, cwd, connection, provider, sessionId]);

  // Load UI messages from IndexedDB
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    loadAgentMessages(sessionId).then((loaded) => {
      if (!cancelled && loaded.length > 0) setMessages(loaded);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Save UI messages on unmount (tab close)
  useEffect(() => {
    const sid = sessionId;
    const maxMessages = settings.agentHistoryMaxMessages;
    return () => {
      if (sid && messagesRef.current.length > 0) {
        saveAgentMessages(sid, messagesRef.current, maxMessages);
      }
    };
  }, [sessionId, settings.agentHistoryMaxMessages]);

  // Capabilities listener
  //
  // Capabilities arrive after every backend (re)connect — first launch,
  // after credential flow, etc. We use this as the
  // canonical sync point for saved prefs vs. backend defaults:
  //
  // - savedPrefs win over `caps.currentXxx` (caps reflect a *fresh* backend
  //   that doesn't know about the user's previous choices yet)
  // - any drift between savedPrefs and caps gets pushed back to the backend
  //   via `setPrefs`, otherwise e.g. bypassPermissions saved in projectConfig
  //   would silently degrade to "default" after a reset
  useEffect(() => {
    const off = window.shelfApi.agent.onCapabilities((id: string, caps: any) => {
      if (id !== tabId) return;
      setCapabilities(caps);
      if (savedPrefs?.model) setStatusModel(savedPrefs.model);
      else if (caps.currentModel) setStatusModel(caps.currentModel);
      if (savedPrefs?.permissionMode) setPermissionMode(savedPrefs.permissionMode);
      else if (caps.currentPermissionMode) setPermissionMode(caps.currentPermissionMode);
      if (savedPrefs?.effort) setCurrentEffort(savedPrefs.effort);
      else if (caps.currentEffort) setCurrentEffort(caps.currentEffort);

      const drift: Record<string, string> = {};
      if (savedPrefs?.model && savedPrefs.model !== caps.currentModel) drift.model = savedPrefs.model;
      if (savedPrefs?.effort && savedPrefs.effort !== caps.currentEffort) drift.effort = savedPrefs.effort;
      if (savedPrefs?.permissionMode && savedPrefs.permissionMode !== caps.currentPermissionMode) {
        drift.permissionMode = savedPrefs.permissionMode;
      }
      if (Object.keys(drift).length > 0) {
        window.shelfApi.agent.setPrefs(tabId, drift);
      }
    });
    return off;
  }, [tabId, savedPrefs]);

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

  // Init status listener — drives the starting-spinner / failed-retry UI.
  useEffect(() => {
    const off = window.shelfApi.agent.onInitStatus((id: string, status) => {
      if (id !== tabId) return;
      setInitStatus(status.state);
      setInitError(status.state === 'failed' ? status.reason : null);
    });
    return off;
  }, [tabId]);

  const handleRetryInit = useCallback(async () => {
    setInitStatus('starting');
    setInitError(null);
    await window.shelfApi.agent.destroy(tabId);
    setCapabilities(null);
    initializedRef.current = false;
    window.shelfApi.agent.init(tabId, cwd, connection, provider, sessionId);
    initializedRef.current = true;
  }, [tabId, cwd, connection, provider, sessionId]);

  // Messages, stream, and status listeners
  useEffect(() => {
    const offMessage = window.shelfApi.agent.onMessage((id: string, msg: any) => {
      if (id !== tabId) return;

      // `plan` is consumed by the sticky panel — never enters the timeline.
      if (msg.type === 'plan') {
        setCurrentPlan(msg.content ?? '');
        return;
      }

      const built = buildAgentMsg(msg, provider);
      if (!built) return;

      // Finalize message wins over any in-flight streaming version of the
      // same msgId. Drop the `streaming` flag (built doesn't set it) so the
      // cursor stops blinking. Provider may also re-emit tool_use/file_edit
      // with `result` populated — same upsert path handles both.
      setMessages((prev) => upsertById(prev, built));
    });

    const offStream = window.shelfApi.agent.onStream((id: string, chunk: any) => {
      if (id !== tabId) return;
      const chunkMsgId: string | undefined = chunk.msgId;
      const chunkType: 'text' | 'thinking' = chunk.type === 'thinking' ? 'thinking' : 'text';
      const delta: string = chunk.content ?? '';
      if (!chunkMsgId || !delta) return;

      // Stream chunk → upsert into the existing entry (if any) by msgId,
      // appending delta content. If no entry yet (first chunk of this
      // block), create a placeholder with `streaming: true` so the cursor
      // shows up. The matching finalize message will replace this entry
      // with the assembled full content (and drop the streaming flag).
      setMessages((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          const m = prev[i];
          if (m.id !== chunkMsgId) continue;
          if (m.type !== 'text' && m.type !== 'thinking') return prev;  // unexpected; ignore
          const next = prev.slice();
          next[i] = { ...m, content: m.content + delta, streaming: true };
          return next;
        }
        return [
          ...prev,
          { id: chunkMsgId, type: chunkType, content: delta, streaming: true, provider, timestamp: Date.now() },
        ];
      });
    });

    const offStatus = window.shelfApi.agent.onStatus((id: string, status: any) => {
      if (id !== tabId) return;
      const nowStreaming = status.state === 'streaming';
      setIsStreaming((wasStreaming) => {
        if (wasStreaming && !nowStreaming) {
          // Turn ended — clear streaming flag on any entry still marked
          // in-flight (no finalize ever landed for it). The content is
          // whatever the stream deltas accumulated; we just stop the
          // cursor. Persistence saver fires shortly after so the user
          // sees a stable state next session open.
          setMessages((prev) => {
            let mutated = false;
            const next = prev.map((m) => {
              if ((m.type === 'text' || m.type === 'thinking') && m.streaming) {
                mutated = true;
                return { ...m, streaming: false };
              }
              return m;
            });
            return mutated ? next : prev;
          });
          if (sessionId) {
            const maxMessages = settings.agentHistoryMaxMessages;
            setTimeout(() => {
              setMessages((cur) => { saveAgentMessages(sessionId, cur, maxMessages); return cur; });
            }, 200);
          }
        }
        return nowStreaming;
      });
      if (status.model) setStatusModel(status.model);
      if (status.costUsd != null) setCostUsd(status.costUsd);
      if (status.numTurns != null) setNumTurns(status.numTurns);
      if (status.contextUsage) setContextUsage(status.contextUsage);
      if (Array.isArray(status.rateLimits) && status.rateLimits.length > 0) setRateLimits(status.rateLimits);
    });

    return () => { offMessage(); offStream(); offStatus(); };
  }, [tabId, provider]);

  // Flush queued messages once the agent goes idle. Mirrors handleSend's
  // exact path (push user bubble + agent.send) — the queued message
  // becomes a regular user message on the next turn. Lives in its own
  // useEffect (not inside the onStatus updater) to avoid side effects in
  // a state updater and to give agent-server one tick to settle before
  // the next IPC.AGENT_SEND fires.
  useEffect(() => {
    if (isStreaming) return;
    if (queuedMessages.length === 0) return;
    const next = queuedMessages[0];
    setQueuedMessages((q) => q.slice(1));
    setMessages((prev) => [...prev, {
      id: `user-${Date.now()}`, type: 'user', content: next.content, timestamp: Date.now(),
    }]);
    // Queued msg flush represents the same intent as handleSend (user
    // pressed send earlier, just had to wait for the previous turn) —
    // re-engage auto-follow so the new turn's stream lands in view.
    setFollow(true);
    window.shelfApi.agent.send(tabId, next.content);
  }, [isStreaming, queuedMessages, tabId, setFollow]);

  // Track user intent only on user-driven scroll inputs. We deliberately
  // ignore the generic `scroll` event because programmatic scrollIntoView
  // also fires it — distinguishing the two used to require a flag + timeout
  // (race-prone). Wheel/touch/keyboard are exclusively user actions.
  //
  // Direction matters: an UP input is unambiguously "stop following, I want
  // to read history" — set follow=false synchronously so the next streaming
  // chunk's auto-scroll effect sees it before firing scrollIntoView, ending
  // the user-vs-smooth-scroll fight that made upward scroll feel sticky.
  // A DOWN input is "catch up if I'm there" — defer to a geometry check in
  // rAF (scrollTop hasn't settled yet inside the handler).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const isAtBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    const recomputeFromGeometry = () => {
      requestAnimationFrame(() => setFollow(isAtBottom()));
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setFollow(false);
      else if (e.deltaY > 0) recomputeFromGeometry();
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const dy = (e.touches[0]?.clientY ?? 0) - touchStartY;
      // Finger moving DOWN (dy > 0) drags content down → reveals earlier
      // history → user is scrolling UP. Inverse for finger UP.
      if (dy > 4) setFollow(false);
      else if (dy < -4) recomputeFromGeometry();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) setFollow(false);
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(e.key)) recomputeFromGeometry();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKey);
    };
  }, [setFollow]);

  // Auto-follow new content. Reads intent only — programmatic scrolls
  // triggered here do not touch followBottomRef, so subsequent stream
  // updates within the same turn keep following without races.
  useEffect(() => {
    if (followBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    // Triggers that change rendered content height:
    // - `messages`: new bubble / streaming chunk / tool result upsert
    // - `isStreaming`: flip toggles the "Agent is running…" spinner
    // - `queuedMessages`: queued chip renders at the bottom of the chat
    //   container; without it in deps, pressing send while a turn is
    //   running adds the chip below the viewport and never scrolls.
  }, [messages, isStreaming, queuedMessages]);

  // When this tab becomes visible again, the auto-scroll effect above
  // could not run while the parent was display:none (scrollIntoView is a
  // no-op on hidden elements). Catch up here: if the user's intent is to
  // follow, snap (not smooth) to bottom so they see the latest content
  // immediately rather than a stale middle.
  useEffect(() => {
    if (!visible) return;
    if (!followBottomRef.current) return;
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, [visible]);

  // Consume Note's "Send to Chat" payload when this tab is the visible
  // agent tab in the staged project. Single-slot stage: only one tab
  // (the first to be visible after staging) consumes; clearing the stage
  // prevents other agent tabs in the same project from re-applying it.
  // Behaviour: append to current input (preserve any unsent typing) and
  // append images to existing pendingImages.
  const projectId = projects[projectIndex]?.config.id;
  useEffect(() => {
    if (!visible || !chatStage) return;
    if (chatStage.projectId !== projectId) return;
    const incoming = chatStage;
    setInput((prev) => {
      const trimmed = prev.trimEnd();
      return trimmed ? `${trimmed}\n\n${incoming.text}` : incoming.text;
    });
    setPendingImages((prev) => [...prev, ...incoming.images]);
    setChatStage(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [visible, chatStage, projectId]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if ((!text && pendingFiles.length === 0 && pendingImages.length === 0)) return;

    // Slash command — dispatch to provider via IPC, act on SlashResult
    const slashMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (slashMatch && !text.includes('\n')) {
      const cmd = slashMatch[1];
      const args = (slashMatch[2] ?? '').trim();
      setInput('');
      void (async () => {
        const result = await window.shelfApi.agent.slashCommand(tabId, cmd, args);
        switch (result.type) {
          case 'show-model-picker': {
            const models = (result.models ?? []) as { value: string; displayName: string }[];
            const current = result.current as string | undefined;
            if (models.length > 0) {
              setCapabilities((prev) => prev ? { ...prev, models } : prev);
              const idx = models.findIndex((m) => m.value === current);
              setModelPicker({ open: true, selected: idx >= 0 ? idx : 0 });
            }
            break;
          }
          case 'switch-model': {
            const model = result.model as string;
            setStatusModel(model);
            window.shelfApi.agent.setPrefs(tabId, { model });
            persistPref({ model });
            const match = capabilities?.models.find((m) => m.value === model);
            setMessages((prev) => [...prev, {
              id: `msg-${Date.now()}`, type: 'system', content: `── Model switched to ${match?.displayName ?? model} ──`, timestamp: Date.now(),
            }]);
            break;
          }
          case 'context-cleared': {
            setMessages((prev) => [...prev, {
              id: `msg-${Date.now()}`, type: 'system', content: `── ${(result.message as string | undefined) ?? 'Context cleared'} ──`, timestamp: Date.now(),
            }]);
            break;
          }
          case 'system-message': {
            setMessages((prev) => [...prev, {
              id: `msg-${Date.now()}`, type: 'system', content: result.content as string, timestamp: Date.now(),
            }]);
            break;
          }
          case 'error': {
            setMessages((prev) => [...prev, {
              id: `msg-${Date.now()}`, type: 'error', content: result.message as string, timestamp: Date.now(),
            }]);
            break;
          }
          case 'pass-through':
          default: {
            // Send the original slash command as a regular message — provider's SDK handles it
            window.shelfApi.agent.send(tabId, text, []);
            setMessages((prev) => [...prev, {
              id: `msg-${Date.now()}`, type: 'user', content: text, timestamp: Date.now(),
            }]);
            break;
          }
        }
      })();
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
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    }]);
    // User explicitly hit send — strong intent to see their message
    // appear. Force re-engage auto-follow even if they had scrolled up
    // while reading earlier history.
    setFollow(true);
    window.shelfApi.agent.send(tabId, text, images.length > 0 ? images : undefined);
  }, [tabId, input, isStreaming, pendingFiles, pendingImages, capabilities, statusModel, setFollow]);

  const handleStop = useCallback(() => {
    setQueuedMessages([]);
    window.shelfApi.agent.stop(tabId);
  }, [tabId]);

  const handleCancelQueued = useCallback((id: string) => {
    setQueuedMessages((q) => q.filter((m) => m.id !== id));
  }, []);

  // Permission response. scope='session' tells provider to remember allow for the rest of the session.
  const handlePermissionRespond = useCallback((allow: boolean, scope?: 'once' | 'session') => {
    if (!pendingPermission) return;
    window.shelfApi.agent.resolvePermission(tabId, pendingPermission.toolUseId, allow, scope);
    setPendingPermission(null);
  }, [tabId, pendingPermission]);

  useEffect(() => {
    if (!pendingPermission) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); setPermSelection((p) => (p > 0 ? p - 1 : 2)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setPermSelection((p) => (p < 2 ? p + 1 : 0)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (permSelection === 0) handlePermissionRespond(true, 'once');
        else if (permSelection === 1) handlePermissionRespond(true, 'session');
        else handlePermissionRespond(false);
      }
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
    persistPref({ model: picked.value });
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
    persistPref({ model: next.value });
  }, [tabId, capabilities, statusModel, persistPref]);

  const handleCycleMode = useCallback(() => {
    if (!capabilities || capabilities.permissionModes.length === 0) return;
    const idx = capabilities.permissionModes.findIndex((m) => m.value === permissionMode);
    const next = capabilities.permissionModes[(idx + 1) % capabilities.permissionModes.length];
    setPermissionMode(next.value);
    window.shelfApi.agent.setPrefs(tabId, { permissionMode: next.value });
    persistPref({ permissionMode: next.value });
  }, [tabId, capabilities, permissionMode, persistPref]);

  const handleCycleEffort = useCallback(() => {
    if (!capabilities || capabilities.effortLevels.length === 0) return;
    const idx = capabilities.effortLevels.findIndex((e) => e.value === currentEffort);
    const next = capabilities.effortLevels[(idx + 1) % capabilities.effortLevels.length];
    setCurrentEffort(next.value);
    window.shelfApi.agent.setPrefs(tabId, { effort: next.value });
    persistPref({ effort: next.value });
  }, [tabId, capabilities, currentEffort, persistPref]);

  const handleClearHistory = useCallback(async () => {
    // Lightweight cleanup: wipe what the user sees (in-memory + IDB rows
    // for this session). Do NOT touch the agent backend, sessionId, or
    // accumulated status indicators (cost / turns / context %). The agent
    // keeps its memory — if the user wants to also reset agent context,
    // they use `/clear` slash command which has provider-side semantics
    // (Claude SDK's own /clear, Copilot's context-cleared pathway).
    if (sessionId) await clearAgentSession(sessionId);
    setMessages([]);
  }, [sessionId]);

  // Slash menu
  const filteredCommands = useMemo(() => {
    return capabilities?.slashCommands.filter(
      (cmd) => !slashFilter || cmd.name.toLowerCase().startsWith(slashFilter.toLowerCase()),
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

  const currentModeOption = capabilities?.permissionModes.find((m) => m.value === permissionMode);
  const currentEffortOption = capabilities?.effortLevels.find((e) => e.value === currentEffort);

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
        {initStatus === 'starting' && messages.length === 0 && (
          <div className="agent-init-pane">
            <span className="agent-loading-spinner" />
            <span className="agent-loading-text">Starting agent…</span>
          </div>
        )}
        {initStatus === 'failed' && (
          <div className="agent-init-pane agent-init-failed">
            <div className="agent-init-failed-title">Failed to start agent</div>
            {initError && <div className="agent-init-failed-reason">{initError}</div>}
            <button className="conn-btn conn-btn-next" onClick={handleRetryInit}>Retry</button>
          </div>
        )}
        {initStatus === 'ready' && messages.length === 0 && !isStreaming && <div className="agent-empty">Send a message to start</div>}
        {turns.map((turn, ti) => {
          // Streaming content now lives in the messages array as entries
          // with `streaming: true` — AgentMessage renders the cursor when
          // that flag is set, so the timeline visually shows the in-flight
          // chunk inline without a separate render branch.
          const hasResponseContent = turn.agent.length > 0;
          return (
            <div key={turn.user?.id ?? `turn-${ti}`} className="agent-turn">
              {turn.user && <AgentMessage message={turn.user} cwd={cwd} />}
              {hasResponseContent && (
                <div className="agent-turn-response">
                  {turn.agent.map((msg) => <AgentMessage key={msg.id} message={msg} cwd={cwd} />)}
                </div>
              )}
            </div>
          );
        })}
        {(() => {
          // Spinner = "agent alive" indicator when nothing visible is
          // happening yet. With the new pipeline, any visible activity
          // shows up in `messages` as a `streaming: true` text/thinking
          // entry (which has its own cursor). The spinner only matters
          // during the initial wait before any chunk arrives.
          const thinkingDisplay = settings.agentDisplay?.thinking ?? 'collapsed';
          const hasVisibleStreaming = messages.some((m) => {
            if (m.type === 'text' && m.streaming) return true;
            if (m.type === 'thinking' && m.streaming && thinkingDisplay !== 'hidden') return true;
            return false;
          });
          const showSpinner = isStreaming && !hasVisibleStreaming && messages.length > 0;
          if (!showSpinner) return null;
          return (
            <div className="agent-loading">
              <span className="agent-loading-spinner" />
              <span className="agent-loading-text">Agent is running... (Esc to stop)</span>
            </div>
          );
        })()}
        {queuedMessages.map((q) => (
          <div key={q.id} className="agent-msg agent-msg-user agent-msg-queued">
            <div className="agent-msg-content">{q.content}</div>
            <span className="agent-queued-label">queued</span>
            <button className="agent-queued-cancel" onClick={() => handleCancelQueued(q.id)} title="Cancel">×</button>
          </div>
        ))}
        <div ref={bottomRef} />
        {showJumpFab && (
          <button
            className="agent-jump-fab"
            onClick={() => {
              setFollow(true);
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
            title="Jump to latest"
            aria-label="Jump to latest"
          >
            ↓
          </button>
        )}
      </div>

      {pendingPermission && (
        <div className="agent-permission">
          <div className="agent-permission-header">Allow <strong>{pendingPermission.toolName}</strong>?</div>
          <pre className="agent-permission-input">{JSON.stringify(pendingPermission.input, null, 2)}</pre>
          <div className="agent-perm-options">
            {([
              { label: 'Allow once', kind: 'allow', onClick: () => handlePermissionRespond(true, 'once') },
              { label: 'Allow for session', kind: 'allow', onClick: () => handlePermissionRespond(true, 'session') },
              { label: 'Deny', kind: 'deny', onClick: () => handlePermissionRespond(false) },
            ] as const).map((opt, i) => (
              <div key={opt.label} className={`agent-perm-option agent-perm-option-${opt.kind}${permSelection === i ? ' selected' : ''}`} onClick={opt.onClick}>
                <span className="agent-perm-indicator">{permSelection === i ? '▶' : ' '}</span>
                <span>{opt.label}</span>
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

      {currentPlan.trim() && (
        <div className="agent-plan-panel">
          <div className="agent-plan-header">Plan</div>
          <pre className="agent-plan-body">{currentPlan}</pre>
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
        <span className="agent-status-seg">{provider.charAt(0).toUpperCase() + provider.slice(1)}</span>
        {statusModel && (
          <>
            <span className="agent-status-sep">|</span>
            <span className={`agent-status-seg${capabilities ? ' agent-status-interactive' : ''}`} onClick={handleCycleModel}>{statusModel}</span>
          </>
        )}
        {capabilities && capabilities.permissionModes.length > 0 && currentModeOption && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg agent-status-interactive" data-severity={currentModeOption.severity ?? 'normal'} onClick={handleCycleMode}>
              {currentModeOption.displayName}
            </span>
          </>
        )}
        {capabilities && capabilities.effortLevels.length > 0 && currentEffortOption && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg agent-status-interactive" data-severity={currentEffortOption.severity ?? 'normal'} onClick={handleCycleEffort}>
              <span className="agent-status-seg-label">effort: </span>{currentEffortOption.displayName}
            </span>
          </>
        )}
        {contextUsage && (
          <><span className="agent-status-sep">|</span><span className="agent-status-seg" data-severity={contextUsage.severity ?? 'normal'}>{contextUsage.text}</span></>
        )}
        {costUsd !== undefined && <><span className="agent-status-sep">|</span><span className="agent-status-seg">${costUsd.toFixed(3)}</span></>}
        {numTurns !== undefined && <><span className="agent-status-sep">|</span><span className="agent-status-seg">{numTurns} turns</span></>}
        {rateLimits.map((seg, i) => (
          <React.Fragment key={`rl-${i}`}>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg" data-severity={seg.severity ?? 'normal'}>{seg.text}</span>
          </React.Fragment>
        ))}
        <span style={{ marginLeft: 'auto' }} />
        <button className="agent-reset-btn" onClick={handleClearHistory} disabled={isStreaming} title="Clear visible messages (agent keeps its memory; use /clear to reset agent context)">Clear History</button>
      </div>
    </div>
  );
}
