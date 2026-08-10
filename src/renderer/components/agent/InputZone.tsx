import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentAttachment, AgentPrefs, Connection } from '@shared/types';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { useStore, setChatStage } from '../../store';
import {
  clearPendingSends,
  enqueuePendingSend,
  setLocalPicker as setLocalPickerStore,
  useAgentTab,
} from '../../agentTabStore';
import { emitAgent } from '../../events';
import { useAttachmentPaste } from '../../hooks/useAttachmentPaste';
import { backendAttachments, historyImagePreviews, type PendingImageAttachment } from '../../utils/agent-send-attachments';
import { OPTIONED_SLASHES, useSlashCommands, type SlashCommand } from './slash-commands';
import { SlashMenu } from './SlashMenu';
import { AttachmentChips } from './AttachmentChips';

function imageExtFromMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

async function stageImagesForSend(
  dataUrls: string[],
  connection: Connection,
  cwd: string,
): Promise<PendingImageAttachment[]> {
  const staged: PendingImageAttachment[] = [];
  const failures: string[] = [];
  const cwdPrefix = cwd.replace(/\/+$/, '') + '/';

  for (const [i, dataUrl] of dataUrls.entries()) {
    try {
      const response = await fetch(dataUrl);
      const buffer = await response.arrayBuffer();
      const mimeType = response.headers.get('content-type') || /^data:([^;]+);base64,/i.exec(dataUrl)?.[1] || 'image/png';
      const name = `note-image-${i + 1}.${imageExtFromMime(mimeType)}`;
      const result = await window.shelfApi.connector.uploadFile(connection, cwd, name, buffer);
      if (!result.ok) {
        failures.push(`${name}: ${result.reason}`);
        continue;
      }
      const displayPath = result.remotePath.startsWith(cwdPrefix)
        ? result.remotePath.slice(cwdPrefix.length)
        : result.remotePath;
      staged.push({
        previewUrl: dataUrl,
        attachment: {
          kind: 'image',
          path: result.remotePath,
          displayPath,
          name,
          mimeType,
          size: buffer.byteLength,
        },
      });
    } catch (err: any) {
      failures.push(`image ${i + 1}: ${err?.message ?? String(err)}`);
    }
  }

  if (failures.length > 0) {
    void window.shelfApi.dialog.warn('Upload failed', failures.join('\n'));
  }
  return staged;
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
  /** User intent for model / effort / permissionMode. Source of truth
   *  for what gets sent in the next AGENT_SEND payload. **Not** the
   *  same as store.actual* — actual reflects what the backend reports
   *  (possibly after a fallback / cap), intent reflects what the user
   *  asked for. We send intent so a backend fallback doesn't silently
   *  pin future executions to the fallback model. See agent-ui#4. */
  intent: AgentPrefs | undefined;
}

/**
 * Input area for an agent tab: textarea + slash menu + attachment
 * chips + ESC-twice-to-stop. Owns its UI-mediator state (input value,
 * slash menu open/filter/selection, pending files/images, ESC pending
 * flag) — none of which other components read. Domain reads come from
 * agentTabStore via useAgentTab.
 *
 * Outbound: every submission EAGER-sends 'agent:send' immediately with a
 * renderer-minted `clientMsgId` (no client-side queueing / execution-boundary
 * guessing — agent-server owns the queue). The submission also records an
 * optimistic pending chip (enqueuePendingSend); the server's queue snapshot
 * promotes it into the timeline when its execution runs. Config slashes: with-arg
 * (/model X) falls through to agent:send (provider's slash handler); no-arg
 * (/model) opens the renderer-local picker via setLocalPicker (DecisionPanel
 * renders it and emits the config-edit execution on select).
 */
export function InputZone({ tabId, projectId, cwd, connection, visible, rootRef, intent }: Props) {
  const tab = useAgentTab(tabId);
  const { settings, chatStage } = useStore();

  const isExecutionActive = tab?.isExecutionActive ?? false;
  const pendingCount = tab?.pendingSends.length ?? 0;
  // "Busy" = a execution is running OR sends are still queued. Used for ESC-to-stop
  // and the streaming→idle reset so ESC keeps working across the brief inter-execution
  // idle gap while the server drains the queue.
  const busy = isExecutionActive || pendingCount > 0;
  // Init readiness gate. The agent is usable only once the backend reports
  // init 'ready' (capabilities gathered). While 'starting' — or 'failed' (e.g.
  // the caps RPC timed out, meaning the SDK/CLI link is unhealthy) — the input
  // is locked: no send is emitted and nothing is queued (a queued send implies
  // eventual delivery we can't promise before init succeeds). 'failed' surfaces
  // the Retry affordance in the message list above. See agent-config-flow.
  const initStatus = tab?.initStatus ?? 'starting';
  const initReady = initStatus === 'ready';
  const capabilities = tab?.capabilities ?? null;
  // store.actual* reads stay — they're used for the vision-capability
  // check (matches model in capabilities.models list) and as the
  // current value in localPicker selection. Send payload uses `intent`.
  const statusModel = tab?.actualModel ?? null;

  const [input, setInput] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelection, setSlashSelection] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<AgentAttachment[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>([]);
  const [stagingImages, setStagingImages] = useState(false);
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
        ...uploads.map((u) => ({
          kind: 'file' as const,
          path: u.remotePath,
          displayPath: u.displayPath,
          name: u.file.name,
          mimeType: u.file.type || undefined,
          size: u.file.size,
        })),
      ]);
    },
    onImages: (images) => {
      // No vision pre-gate: always accept images and let the agent report an
      // error if the model can't take them. A `vision` capability flag is hard
      // to keep accurate per model/provider, and pre-blocking on a stale/absent
      // flag wrongly drops images a capable model would accept.
      if (images.length > 0) {
        setPendingImages((prev) => [
          ...prev,
          ...images.map((image) => ({ previewUrl: image.dataUrl, attachment: image.attachment })),
        ]);
      }
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
    if (incoming.images.length > 0) {
      setStagingImages(true);
      void stageImagesForSend(incoming.images, connection, cwd)
        .then((images) => {
          if (images.length > 0) setPendingImages((prev) => [...prev, ...images]);
        })
        .finally(() => setStagingImages(false));
    }
    setChatStage(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [visible, chatStage, projectId, connection, cwd]);

  // ESC pending reset when the agent goes fully idle (no running execution AND no
  // queued sends) — clears any half-armed double-tap so the next ESC isn't
  // surprise-stopping the (now-idle) agent.
  useEffect(() => {
    if (busy) return;
    escPendingRef.current = false;
    setEscPending(false);
    if (escTimerRef.current) { clearTimeout(escTimerRef.current); escTimerRef.current = null; }
  }, [busy]);

  // Textarea auto-resize. Cap at 200px so a multi-screen paste
  // doesn't push the timeline out of view.
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }, [input]);

  const { filteredCommands, allCommandNames } = useSlashCommands(capabilities, slashFilter);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && pendingFiles.length === 0 && pendingImages.length === 0) return;
    // Locked until init 'ready' — don't emit, don't queue. Belt-and-suspenders:
    // the textarea is also disabled when !initReady, so Enter can't reach here.
    if (!initReady) return;
    if (stagingImages) return;

    // Inline picker shortcut: `/model` / `/effort` / `/permission` without
    // args opens a renderer-side picker (options come from capabilities,
    // no backend round-trip needed). With-args (e.g. `/model claude-sonnet`)
    // falls through to agent.send below — provider's slash handler is the
    // single source of truth for "did the switch actually happen", emits a
    // fold_markdown reply card, and broadcasts updated capabilities. The
    // renderer persists through the project mutation boundary into canonical
    // `Project.agentPrefs` (`Project` is defined by `@shared/projects`) when
    // capabilities reports the new value (see AgentView's persist effect).
    const slash = parseSlashPrefix(text);
    const pickerKey = slash ? OPTIONED_SLASHES[slash.cmd] : undefined;
    if (slash && pickerKey && !slash.args) {
      setInput('');
      setShowSlashMenu(false);
      setLocalPickerStore(tabId, { key: pickerKey });
      return;
    }

    // Agent-bound slashes (/help /context /compact /clear) flow
    // through agent.send as normal text — provider parses + dispatches
    // internally; output arrives as fold_markdown messages.
    const files = pendingFiles;
    const images = historyImagePreviews(pendingImages);
    const attachments = backendAttachments(files, pendingImages);
    setInput('');
    setPendingFiles([]);
    setPendingImages([]);
    setShowSlashMenu(false);

    // Eager send: emit immediately with a renderer-minted clientMsgId — no
    // client-side queueing or execution-boundary guessing. agent-server owns the
    // queue; it echoes the clientMsgId in the queue snapshot. The optimistic
    // pending chip (enqueuePendingSend) shows instantly; the snapshot promotes
    // it into the timeline when its execution runs. Preview images stay renderer-local
    // for history; provider-bound payload uses uploaded attachments.
    const clientMsgId = crypto.randomUUID();
    enqueuePendingSend(tabId, clientMsgId, text, images, files.length > 0 ? files : undefined);
    emitAgent('agent:send', {
      tabId,
      text,
      attachments,
      prefs: {
        model: intent?.model,
        effort: intent?.effort,
        permissionMode: intent?.permissionMode,
      },
      clientMsgId,
    });
  }, [tabId, input, pendingFiles, pendingImages, stagingImages, intent, initReady]);

  const handleStop = useCallback(() => {
    // ESC-twice (stop) means "abort this execution AND drop everything I queued up
    // while it was running". The server clears its queue on stop; we clear the
    // local optimistic chips too (incl. not-yet-confirmed ones). The running
    // execution — already a timeline bubble — stays, marked interrupted by the agent.
    clearPendingSends(tabId);
    emitAgent('agent:stop', { tabId });
  }, [tabId]);

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
      if (busy) {
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
        <SlashMenu
          commands={filteredCommands}
          selection={slashSelection}
          onSelect={handleSlashSelect}
          onHover={setSlashSelection}
        />
      )}
      {(pendingFiles.length > 0 || pendingImages.length > 0) && (
        <AttachmentChips
          images={pendingImages.map((image) => image.previewUrl)}
          files={pendingFiles}
          onRemoveImage={(i) => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
          onRemoveFile={(path) => setPendingFiles((prev) => prev.filter((p) => p.path !== path))}
        />
      )}
      <div className="agent-input-row">
        <span className="agent-prompt">&#10095;</span>
        <textarea
          ref={inputRef}
          className="agent-textarea"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={!initReady}
          placeholder={
            initReady
              ? 'Ask something...'
              : initStatus === 'failed'
                ? 'Agent unavailable — retry to reconnect'
                : 'Starting agent…'
          }
          rows={1}
        />
        {escPending && <span className="agent-esc-hint">Press Esc again to stop</span>}
      </div>
    </div>
  );
}
