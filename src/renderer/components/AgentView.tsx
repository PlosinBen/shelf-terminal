import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { AgentProvider, AgentPrefs, Connection } from '@shared/types';
import { type AgentMsg } from './AgentMessage';
import { MessageList } from './agent/MessageList';
import { SelectionPanel } from './SelectionPanel';
import { PickerPanel } from './PickerPanel';
import { parseSlashPrefix } from '@shared/slash-prefix';
import {
  initTab as initTabStore,
  removeTab as removeTabStore,
  upsertMessage,
  enqueueMessage,
  dequeueMessage,
  clearQueuedMessages,
  clearMessages as clearMessagesStore,
  setActualModel,
  setActualEffort,
  setActualPermissionMode,
  setAuthBusy,
  setAuthError,
  setAuthRequired,
  setCapabilities as setCapabilitiesStore,
  setInitStatus as setInitStatusStore,
  setLocalPicker as setLocalPickerStore,
  setPendingPermission as setPendingPermissionStore,
  setPendingPicker as setPendingPickerStore,
  useAgentTab,
} from '../agentTabStore';
import { emitAgent } from '../events';

/**
 * Slash commands that mutate renderer-owned project config (model / effort /
 * permissionMode). These are "config edits" via slash syntax — same effect as
 * cycling via the status bar, just keyboard-driven. Renderer intercepts them
 * entirely; nothing goes to agent-server (the next AGENT_SEND carries the new
 * pref value and the orchestrator's diff detector fires setX on the provider).
 *
 * Map: user-facing slash name → internal pref key in projectConfig.agentPrefs.
 * The two diverge for `permission` because `/permissionMode` would be a
 * camelCase eyesore in a slash menu (everything else is single-word lowercase
 * to match `/clear`, `/compact`, etc.); the pref key stays `permissionMode`
 * to match its existing AgentPrefs / settings shape.
 *
 * Anything not in this map falls through to agent.send — provider parses
 * and dispatches.
 */
const RENDERER_LOCAL_SLASHES: Record<string, 'model' | 'effort' | 'permissionMode'> = {
  model: 'model',
  effort: 'effort',
  permission: 'permissionMode',
};
import { useAttachmentPaste } from '../hooks/useAttachmentPaste';
import { useStore, updateProjectConfig, setChatStage } from '../store';

// Local-only types — store's Capabilities is the source of truth and
// tabState.capabilities carries it. SlashCommand is the shape of items
// shown in the slash autocomplete menu (subset of Capabilities['slashCommands']).
interface SlashCommand {
  name: string;
  description: string;
}

interface Props {
  tabId: string;
  cwd: string;
  connection: Connection;
  provider: AgentProvider;
  projectId: string;
  visible: boolean;
}

export function AgentView({ tabId, cwd, connection, provider, projectId, visible }: Props) {
  const { projects, settings, chatStage } = useStore();
  // Derive index from stable id every render — projectIndex (array position)
  // shifts when user reorders projects via drag, which would otherwise point
  // this AgentView at the wrong project's prefs / sessionIds. See
  // .agent/GOTCHAS.md "AgentView projectIndex drift on reorder".
  const projectIndex = projects.findIndex((p) => p.config.id === projectId);
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

  // Domain state lives in agentTabStore now. AgentView subscribes via
  // useAgentTab so only changes for THIS tab trigger a re-render
  // (unlike the global useStore which rebuilds snapshot on every
  // change). The slice is created synchronously by initTab in the
  // mount effect below; until that runs, `tabState` is undefined and
  // we fall back to safe defaults.
  const tabState = useAgentTab(tabId);
  const messages: AgentMsg[] = tabState?.messages ?? [];
  const currentPlan = tabState?.currentPlan ?? '';
  const isStreaming = tabState?.isStreaming ?? false;
  const statusModel = tabState?.actualModel ?? null;
  const costUsd = tabState?.costUsd;
  const numTurns = tabState?.numTurns;
  const contextUsage = tabState?.contextUsage ?? null;
  const rateLimits = tabState?.rateLimits ?? [];
  const capabilities = tabState?.capabilities ?? null;
  const permissionMode = tabState?.actualPermissionMode ?? 'default';
  const currentEffort = tabState?.actualEffort ?? 'medium';
  const pendingPermission = tabState?.pendingPermission ?? null;
  const pendingPicker = tabState?.pendingPicker ?? null;
  const localPicker = tabState?.localPicker ?? null;
  const queuedMessages = tabState?.queuedMessages ?? [];
  const authRequired = tabState?.authRequired ?? null;
  const authBusy = tabState?.authBusy ?? false;
  const authError = tabState?.authError ?? null;
  const initStatus = tabState?.initStatus ?? 'starting';
  const initError = tabState?.initError ?? null;

  // Input zone state stays local — no external reader. Same for slash
  // menu, ESC pending, and pending attachments. These move into
  // <InputZone> in PR 5; for now they're still wired into AgentView.
  const [input, setInput] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelection, setSlashSelection] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<Array<{ path: string; displayPath: string }>>([]);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [escPending, setEscPending] = useState(false);
  const escPendingRef = useRef(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistPref = useCallback((partial: Partial<AgentPrefs>) => {
    const current = projects[projectIndex]?.config.agentPrefs ?? {};
    const updated = { ...current, [provider]: { ...current[provider], ...partial } };
    updateProjectConfig(projectIndex, { agentPrefs: updated });
  }, [projectIndex, provider, projects]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // listRef / bottomRef / followBottom / showJumpFab moved into
  // <MessageList>. AgentView no longer owns scroll geometry; when it
  // needs the timeline to snap to bottom (after handleSend / queue
  // flush), it emits 'agent:scrollToBottom' which MessageList listens
  // for. initTab is idempotent + keyed on tabId so no init guard ref
  // is needed.

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

  // Per-tab lifecycle: initTab creates the slice (synchronously),
  // warm-starts actual* from savedPrefs (intent), and triggers async
  // IDB load. Backend events route through agentTabSubscriptions →
  // store actions; this component just emits the init request.
  // removeTab on unmount flushes any pending IDB save synchronously.
  useEffect(() => {
    initTabStore(tabId, {
      sessionId,
      provider,
      intent: savedPrefs,
    });
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId });
    return () => {
      removeTabStore(tabId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const handleRetryInit = useCallback(async () => {
    setInitStatusStore(tabId, 'starting');
    emitAgent('agent:destroy', { tabId });
    setCapabilitiesStore(tabId, null);
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId });
  }, [tabId, cwd, connection, provider, sessionId]);

  // Flush queued messages once the agent goes idle. Mirrors handleSend's
  // exact path (push user bubble + agent.send) — the queued message
  // becomes a regular user message on the next turn. Lives in its own
  // useEffect (not inside the onStatus updater) to avoid side effects in
  // a state updater and to give agent-server one tick to settle before
  // the next IPC.AGENT_SEND fires.
  useEffect(() => {
    if (isStreaming) return;
    if (queuedMessages.length === 0) return;
    const next = dequeueMessage(tabId);
    if (!next) return;
    upsertMessage(tabId, {
      id: `user-${Date.now()}`,
      type: 'user',
      content: next.content,
      timestamp: Date.now(),
    });
    // Queued msg flush represents the same intent as handleSend (user
    // pressed send earlier, just had to wait for the previous turn) —
    // nudge MessageList to snap to bottom so the new turn lands in view.
    emitAgent('agent:scrollToBottom', { tabId });
    emitAgent('agent:send', {
      tabId,
      text: next.content,
      prefs: {
        model: statusModel ?? undefined,
        effort: currentEffort,
        permissionMode,
      },
    });
  }, [isStreaming, queuedMessages, tabId, statusModel, currentEffort, permissionMode]);

  // Scroll-tracking / auto-follow / visible-catchup effects live in
  // <MessageList>. AgentView used to own them because messages lived
  // in component state; now that messages live in the store and
  // MessageList subscribes directly, the effects move alongside.

  // Consume Note's "Send to Chat" payload when this tab is the visible
  // agent tab in the staged project. Single-slot stage: only one tab
  // (the first to be visible after staging) consumes; clearing the stage
  // prevents other agent tabs in the same project from re-applying it.
  // Behaviour: append to current input (preserve any unsent typing) and
  // append images to existing pendingImages.
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

    // Renderer-local slash interception. /model (and future /effort,
    // /permissionMode) mutate project config — semantically equivalent to a
    // status bar cycle, just keyboard-driven. Zero IPC: backend learns of
    // the change on the next normal send via the AGENT_SEND payload.
    //
    // /model <id> applies directly via handleConfigEdit.
    // /model (no arg) opens the renderer-local picker.
    // Anything else falls through to agent.send — provider parses + dispatches.
    const slash = parseSlashPrefix(text);
    const localKey = slash ? RENDERER_LOCAL_SLASHES[slash.cmd] : undefined;
    if (slash && localKey) {
      setInput('');
      setShowSlashMenu(false);
      if (slash.args) {
        handleConfigEdit(localKey, slash.args);
      } else {
        setLocalPickerStore(tabId, { key: localKey });
      }
      return;
    }

    // No further slash special-casing — agent-bound slashes (/help, /context,
    // /compact, /clear) flow through agent.send as normal text. Provider
    // parses prefix and dispatches internally; output arrives via the normal
    // slash_response message stream.
    const files = pendingFiles;
    const images = pendingImages;
    setInput('');
    setPendingFiles([]);
    setPendingImages([]);
    setShowSlashMenu(false);

    if (isStreaming) {
      enqueueMessage(tabId, text);
      return;
    }

    upsertMessage(tabId, {
      id: `user-${Date.now()}`,
      type: 'user',
      content: text,
      timestamp: Date.now(),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    });
    // User explicitly hit send — strong intent to see their message
    // appear. Force snap to bottom even if they had scrolled up while
    // reading earlier history. MessageList listens.
    emitAgent('agent:scrollToBottom', { tabId });
    emitAgent('agent:send', {
      tabId,
      text,
      images: images.length > 0 ? images : undefined,
      prefs: {
        model: statusModel ?? undefined,
        effort: currentEffort,
        permissionMode,
      },
    });
  }, [tabId, input, isStreaming, pendingFiles, pendingImages, capabilities, statusModel, currentEffort, permissionMode]);

  const handleStop = useCallback(() => {
    clearQueuedMessages(tabId);
    emitAgent('agent:stop', { tabId });
  }, [tabId]);

  // handleCancelQueued lives inside <MessageList> now — the cancel
  // button is part of the queued-message row, and MessageList calls
  // cancelQueuedMessage(tabId, id) directly.

  // Permission response. scope='session' tells provider to remember allow for the rest of the session.
  const handlePermissionRespond = useCallback((allow: boolean, scope?: 'once' | 'session') => {
    if (!pendingPermission) return;
    emitAgent('agent:resolvePermission', {
      tabId,
      toolUseId: pendingPermission.toolUseId,
      allow,
      scope,
    });
    setPendingPermissionStore(tabId, null);
  }, [tabId, pendingPermission]);

  // Permission / picker keyboard handling is owned by the <SelectionPanel>
  // component (internal cursor state + window keydown listener with priority
  // capture). AgentView only owns the "is panel open?" gates
  // (pendingPermission / pendingPicker) and the callbacks that act on the
  // selected value.

  /**
   * Apply a config edit (model / effort / permissionMode change). Used by
   * status bar cycle, `/model X` slash, and renderer-local picker resolve.
   * Renderer is the source of truth for prefs — savedPrefs in projectConfig
   * + local status state. Backend learns on the next AGENT_SEND payload
   * (orchestrator diffs and calls provider.setX).
   *
   * No validation: SDK is the final arbiter of model legitimacy (see
   * .agent/DECISIONS.md #55). Typos surface as `error` events when the next
   * send fails to apply.
   */
  const handleConfigEdit = useCallback((key: 'model' | 'effort' | 'permissionMode', value: string) => {
    if (key === 'model') {
      setActualModel(tabId, value);
      persistPref({ model: value });
    } else if (key === 'effort') {
      setActualEffort(tabId, value);
      persistPref({ effort: value });
    } else if (key === 'permissionMode') {
      setActualPermissionMode(tabId, value);
      persistPref({ permissionMode: value });
    }
  }, [tabId, persistPref]);

  // Status bar cycling. Renderer-only — persist to projectConfig and update
  // local status state. Backend learns the new pref on the next AGENT_SEND
  // payload (orchestrator diffs and calls provider.setX). No setPrefs IPC.
  const handleCycleModel = useCallback(() => {
    if (!capabilities || capabilities.models.length === 0) return;
    const idx = capabilities.models.findIndex((m) => m.value === statusModel);
    const next = capabilities.models[(idx + 1) % capabilities.models.length];
    handleConfigEdit('model', next.value);
  }, [capabilities, statusModel, handleConfigEdit]);

  const handleCycleMode = useCallback(() => {
    if (!capabilities || capabilities.permissionModes.length === 0) return;
    const idx = capabilities.permissionModes.findIndex((m) => m.value === permissionMode);
    const next = capabilities.permissionModes[(idx + 1) % capabilities.permissionModes.length];
    handleConfigEdit('permissionMode', next.value);
  }, [capabilities, permissionMode, handleConfigEdit]);

  const handleCycleEffort = useCallback(() => {
    if (!capabilities || capabilities.effortLevels.length === 0) return;
    const idx = capabilities.effortLevels.findIndex((e) => e.value === currentEffort);
    const next = capabilities.effortLevels[(idx + 1) % capabilities.effortLevels.length];
    handleConfigEdit('effort', next.value);
  }, [capabilities, currentEffort, handleConfigEdit]);

  const handleClearHistory = useCallback(async () => {
    // Lightweight cleanup: wipe what the user sees (in-memory + IDB rows
    // for this session). Do NOT touch the agent backend, sessionId, or
    // accumulated status indicators (cost / turns / context %). The agent
    // keeps its memory — if the user wants to also reset agent context,
    // they use `/clear` slash command which has provider-side semantics
    // (Claude SDK's own /clear, Copilot's context-cleared pathway).
    await clearMessagesStore(tabId);
  }, [tabId]);

  // Slash menu: union of provider-declared agent slashes and renderer-local
  // config-edit slashes. Display layer only — routing in handleSend decides
  // who actually handles each. Names are short-circuit unique (provider
  // shouldn't claim /model after step E cleanup; renderer-local list is the
  // canonical source for those names), so a simple concat + dedup is fine.
  const allCommands = useMemo(() => {
    const providerCmds = capabilities?.slashCommands ?? [];
    const localCmds = Object.keys(RENDERER_LOCAL_SLASHES).map((name) => {
      const description =
        name === 'model' ? 'Switch agent model' :
        name === 'effort' ? 'Set reasoning effort' :
        name === 'permission' ? 'Set permission mode' :
        '';
      return { name, description };
    });
    const seen = new Set<string>();
    const merged: { name: string; description: string }[] = [];
    for (const cmd of [...providerCmds, ...localCmds]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      merged.push(cmd);
    }
    return merged;
  }, [capabilities]);

  const filteredCommands = useMemo(() => {
    return allCommands.filter(
      (cmd) => !slashFilter || cmd.name.toLowerCase().startsWith(slashFilter.toLowerCase()),
    );
  }, [allCommands, slashFilter]);

  const allCommandNames = useMemo(
    () => new Set(allCommands.map((c) => c.name)),
    [allCommands],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    // Slash menu is for *command name* autocomplete only:
    // - Show while user types the slash command (`/m`, `/mo`, `/model`)
    // - Hide once they've typed an exact known cmd name (nothing more to
    //   autocomplete — keeping it open just blocks Enter from submitting)
    // - Hide once they add a space (now in "args" territory, e.g. `/model
    //   claude-sonnet`)
    //
    // Pattern: `/` followed by zero or more word chars, nothing else.
    const matchesSlashShape = /^\/\w*$/.test(val);
    const filter = val.slice(1);
    const isExactMatch = filter.length > 0 && allCommandNames.has(filter);
    if (matchesSlashShape && !isExactMatch) {
      setSlashFilter(filter);
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

    // Swallow Tab so focus doesn't jump to surrounding buttons (e.g. Clear
    // History) and trigger destructive actions on accidental Enter.
    if (e.key === 'Tab') { e.preventDefault(); return; }

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

  // Turn grouping moved into <MessageList> (the only consumer).
  const currentModeOption = capabilities?.permissionModes.find((m) => m.value === permissionMode);
  const currentEffortOption = capabilities?.effortLevels.find((e) => e.value === currentEffort);

  // Auth required screen
  if (authRequired) {
    const authMethod = capabilities?.authMethod;
    const providerLabel = authRequired.provider.charAt(0).toUpperCase() + authRequired.provider.slice(1);

    const retry = async () => {
      setAuthBusy(tabId, true);
      setAuthError(tabId, null);
      // checkAuth is a query (returns Promise<boolean>), not a notify
      // — direct IPC keeps the return value. Going through emit would
      // need an inbound 'agent:onAuthChecked' event, not worth the
      // extra plumbing for a one-shot UI affordance.
      const result = await window.shelfApi.agent.checkAuth(tabId);
      if (result) {
        setAuthRequired(tabId, null);
        setAuthError(tabId, null);
      } else {
        setAuthError(tabId, 'Still no valid credentials found.');
      }
      setAuthBusy(tabId, false);
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
      <MessageList
        tabId={tabId}
        cwd={cwd}
        visible={visible}
        onRetryInit={handleRetryInit}
      />

      {/* Priority gate: permission (agent-driven blocking) > picker (user-driven).
          When both want to show, permission takes the panel and picker state
          stays preserved; permission resolution lets picker re-render
          naturally via this conditional. See plan: UI focus rules. */}
      {pendingPermission ? (
        <SelectionPanel
          title={<>Allow <strong>{pendingPermission.toolName}</strong>?</>}
          description={<pre>{JSON.stringify(pendingPermission.input, null, 2)}</pre>}
          options={[
            { value: 'once',    label: 'Allow once',        kind: 'allow' },
            { value: 'session', label: 'Allow for session', kind: 'allow' },
            { value: 'deny',    label: 'Deny',              kind: 'deny'  },
          ]}
          onSelect={(value) => {
            if (value === 'once') handlePermissionRespond(true, 'once');
            else if (value === 'session') handlePermissionRespond(true, 'session');
            else handlePermissionRespond(false);
          }}
        />
      ) : pendingPicker ? (
        <PickerPanel
          prompts={pendingPicker.prompts}
          onSubmit={(answers) => {
            emitAgent('agent:resolvePicker', {
              tabId,
              pickerId: pendingPicker.id,
              payload: { answers },
            });
            setPendingPickerStore(tabId, null);
          }}
          onCancel={() => {
            emitAgent('agent:resolvePicker', {
              tabId,
              pickerId: pendingPicker.id,
              payload: { cancelled: true },
            });
            setPendingPickerStore(tabId, null);
          }}
        />
      ) : localPicker ? (() => {
        // Renderer-local picker for config edits (/model, future /effort
        // /permissionMode). Options + current value derived from
        // capabilities at render time — no provider roundtrip.
        const key = localPicker.key;
        const options = key === 'model'
          ? (capabilities?.models ?? []).map((m) => ({ value: m.value, label: m.displayName }))
          : key === 'effort'
            ? (capabilities?.effortLevels ?? []).map((e) => ({ value: e.value, label: e.displayName }))
            : (capabilities?.permissionModes ?? []).map((p) => ({ value: p.value, label: p.displayName }));
        const current = key === 'model' ? statusModel : key === 'effort' ? currentEffort : permissionMode;
        const title = key === 'model' ? 'Select model' : key === 'effort' ? 'Select effort' : 'Select permission mode';
        return (
          <SelectionPanel
            title={title}
            options={options}
            initialSelected={Math.max(0, options.findIndex((o) => o.value === current))}
            cancellable
            onSelect={(value) => {
              handleConfigEdit(key, value);
              setLocalPickerStore(tabId, null);
            }}
            onCancel={() => setLocalPickerStore(tabId, null)}
          />
        );
      })() : null}

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
