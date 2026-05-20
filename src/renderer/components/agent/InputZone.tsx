import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Connection } from '@shared/types';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { useStore, setChatStage } from '../../store';
import {
  clearQueuedMessages,
  dequeueMessage,
  enqueueMessage,
  setLocalPicker as setLocalPickerStore,
  upsertMessage,
  useAgentTab,
} from '../../agentTabStore';
import { emitAgent } from '../../events';
import { useAttachmentPaste } from '../../hooks/useAttachmentPaste';

const RENDERER_LOCAL_SLASHES: Record<string, 'model' | 'effort' | 'permissionMode'> = {
  model: 'model',
  effort: 'effort',
  permission: 'permissionMode',
};

interface SlashCommand {
  name: string;
  description: string;
}

interface Props {
  tabId: string;
  projectId: string;
  cwd: string;
  connection: Connection;
  visible: boolean;
  /** Container ref used as the drop target / paste host for attachments.
   *  AgentView passes its rootRef so paste anywhere in the agent area
   *  is captured. */
  rootRef: React.RefObject<HTMLDivElement | null>;
  /** Bridge to AgentView's persistPref + setActualX optimistic update.
   *  Kept as a prop (not a store action) because persisting requires
   *  projectIndex which AgentView already has lazy-bound. PR 6/7 may
   *  centralize this into a store action that takes projectId. */
  onConfigEdit: (key: 'model' | 'effort' | 'permissionMode', value: string) => void;
}

/**
 * Input area for an agent tab: textarea + slash menu + attachment
 * chips + ESC-twice-to-stop. Owns its UI-mediator state (input value,
 * slash menu open/filter/selection, pending files/images, ESC pending
 * flag) — none of which other components read. Domain reads come from
 * agentTabStore via useAgentTab.
 *
 * Outbound: emits 'agent:send' / 'agent:stop' / 'agent:scrollToBottom'.
 * No direct IPC calls. The renderer-local config-edit path (/model
 * etc) goes through onConfigEdit (immediate apply with arg) or
 * setLocalPicker (open the picker if no arg).
 */
export function InputZone({ tabId, projectId, cwd, connection, visible, rootRef, onConfigEdit }: Props) {
  const tab = useAgentTab(tabId);
  const { settings, chatStage } = useStore();

  const isStreaming = tab?.isStreaming ?? false;
  const queuedMessages = tab?.queuedMessages ?? [];
  const capabilities = tab?.capabilities ?? null;
  const statusModel = tab?.actualModel ?? null;
  const currentEffort = tab?.actualEffort ?? 'medium';
  const permissionMode = tab?.actualPermissionMode ?? 'default';

  const [input, setInput] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelection, setSlashSelection] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<Array<{ path: string; displayPath: string }>>([]);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [escPending, setEscPending] = useState(false);
  const escPendingRef = useRef(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus on visible — tab switch / project switch / app launch.
  // rAF defers past the layout pass so the textarea is in the visible
  // DOM (parent flipped from display:none).
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // Attachment paste / drop. Hosted on the AgentView root so paste
  // anywhere in the chat area is captured (not just inside the
  // textarea).
  useAttachmentPaste(rootRef, {
    connection,
    cwd,
    maxUploadSizeMB: settings.maxUploadSizeMB,
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

  // Consume Notes' "Send to Chat" payload. Single-slot stage —
  // clearing on consumption prevents other agent tabs in the same
  // project from re-applying. Append to current input (preserve
  // typing) + append images to pendingImages.
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

  // ESC pending reset on stream end. Streaming → idle clears any
  // half-armed double-tap so the next ESC isn't surprise-stopping
  // the (now-idle) agent.
  useEffect(() => {
    if (isStreaming) return;
    escPendingRef.current = false;
    setEscPending(false);
    if (escTimerRef.current) { clearTimeout(escTimerRef.current); escTimerRef.current = null; }
  }, [isStreaming]);

  // Textarea auto-resize. Cap at 200px so a multi-screen paste
  // doesn't push the timeline out of view.
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }, [input]);

  // Slash menu: union of provider-declared agent slashes and
  // renderer-local config-edit slashes. Display layer only — routing
  // in handleSend decides who handles each.
  const allCommands = useMemo<SlashCommand[]>(() => {
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
    const merged: SlashCommand[] = [];
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

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && pendingFiles.length === 0 && pendingImages.length === 0) return;

    // Renderer-local slash interception. /model (and future /effort,
    // /permissionMode) mutate project config — same effect as a status
    // bar cycle, just keyboard-driven. Zero IPC.
    const slash = parseSlashPrefix(text);
    const localKey = slash ? RENDERER_LOCAL_SLASHES[slash.cmd] : undefined;
    if (slash && localKey) {
      setInput('');
      setShowSlashMenu(false);
      if (slash.args) {
        onConfigEdit(localKey, slash.args);
      } else {
        setLocalPickerStore(tabId, { key: localKey });
      }
      return;
    }

    // Agent-bound slashes (/help /context /compact /clear) flow
    // through agent.send as normal text — provider parses + dispatches
    // internally; output arrives as slash_response messages.
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
  }, [tabId, input, isStreaming, pendingFiles, pendingImages, statusModel, currentEffort, permissionMode, onConfigEdit]);

  const handleStop = useCallback(() => {
    // ESC-twice (stop) means "abort this turn AND drop everything I
    // queued up while it was running". If we only stopped the turn,
    // the queue would auto-flush as the next turn — surprising.
    clearQueuedMessages(tabId);
    emitAgent('agent:stop', { tabId });
  }, [tabId]);

  // Queued-message flush. When the agent transitions streaming →
  // idle and queued messages exist, pop the front and send it as a
  // normal turn. Lives here (not in the store) so the same path as
  // handleSend constructs the user bubble + emits agent:send with
  // the current prefs snapshot. Side effect in useEffect (not in
  // the setStreaming action) so agent-server has one tick to settle
  // before the next AGENT_SEND lands.
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

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    // Slash menu is for command-name autocomplete only:
    // - Show while typing the cmd name (`/m`, `/mo`, `/model`)
    // - Hide on exact match (nothing more to autocomplete; keeping it
    //   open would block Enter from submitting)
    // - Hide once a space appears (now in args territory)
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

    // Swallow Tab so focus doesn't jump to surrounding buttons (e.g.
    // Clear History) and trigger destructive actions on Enter.
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
          escTimerRef.current = setTimeout(() => {
            escPendingRef.current = false;
            setEscPending(false);
            escTimerRef.current = null;
          }, 1500);
        }
      }
    }
  };

  return (
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
              <button
                type="button"
                className="agent-attachment-remove"
                onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
              >×</button>
            </span>
          ))}
          {pendingFiles.map((f) => (
            <span key={f.path} className="agent-attachment-chip">
              {f.displayPath}
              <button
                type="button"
                className="agent-attachment-remove"
                onClick={() => setPendingFiles((prev) => prev.filter((p) => p.path !== f.path))}
              >×</button>
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
  );
}
