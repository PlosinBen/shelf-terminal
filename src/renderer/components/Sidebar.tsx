import { isWorktreeUnavailable } from '@shared/worktree';
import { WorktreeScanWarning } from './WorktreeScanWarning';
import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  useStore,
  projectDisplayLabel,
  setActiveProject,
  setEditingProjectById,
  toggleSettings,
  updateSettings,
  projectHealth,
  HEALTH_RANK,
  toggleHideDisconnected,
} from '../store';
import type { ConnectionHealthState } from '@shared/types';
import { emit, Events } from '../events';
import { CONFIRM_REMOVE_EVENT } from './RemoveConfirmDialog';
import { tooltipWithShortcut } from '../utils/format-keybinding';
import { isMac } from '../hooks/useKeybindings';
import { TOGGLE_CONNECTED_FILTER_ACTION } from '@shared/types';
import { computeVisibleProjectIndices } from '../project-grouping';
import { FilterIcon, SearchIcon } from './icons';

export type ProjectSearchKeyAction = 'up' | 'down' | 'activate' | 'close' | 'none';

export function findProjectSearchMatchIndex(label: string, query: string): number {
  if (query.length === 0) return -1;
  return label.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
}

export function decideProjectSearchKey(key: string, isComposing: boolean): ProjectSearchKeyAction {
  if (isComposing) return 'none';
  switch (key) {
    case 'ArrowDown': return 'down';
    case 'ArrowUp': return 'up';
    case 'Enter': return 'activate';
    case 'Escape': return 'close';
    default: return 'none';
  }
}

export function moveProjectSearchCandidate(
  matchIds: readonly string[],
  currentId: string | null,
  direction: -1 | 1,
): string | null {
  if (matchIds.length === 0) return null;
  const currentIndex = currentId === null ? -1 : matchIds.indexOf(currentId);
  if (currentIndex === -1) return direction === 1 ? matchIds[0] : matchIds[matchIds.length - 1];
  const nextIndex = Math.max(0, Math.min(currentIndex + direction, matchIds.length - 1));
  return matchIds[nextIndex];
}

export function resolveProjectSearchCandidate<T extends { id: string }>(
  matches: readonly T[],
  candidateId: string | null,
): T | undefined {
  // projects#12: Enter can arrive before the candidate effect updates after typing.
  return matches.find((match) => match.id === candidateId) ?? matches[0];
}

/**
 * Clamp a context-menu's desired top-left so the whole menu stays on screen
 * (with a small margin). Prefers the requested spot and only pulls the menu
 * back when it would overflow the right/bottom edge; never past the top/left
 * margin (so a menu taller than the viewport stays reachable from the top).
 * Pure so the overflow math is unit-testable without a DOM.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  viewW: number,
  viewH: number,
  margin = 8,
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(x, viewW - menuW - margin)),
    top: Math.max(margin, Math.min(y, viewH - menuH - margin)),
  };
}

// Usable clamp for the draggable sidebar width (px): narrow enough to reclaim
// workspace, wide enough to still read project names.
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 220;

function preventButtonFocus(e: React.MouseEvent<HTMLButtonElement>) {
  e.preventDefault();
}

export function Sidebar() {
  const {
    projects,
    activeProjectIndex,
    hideDisconnected,
    settings,
    connectionHealth,
  } = useStore();
  const kb = settings.keybindings;
  const visibleProjectIndices = useMemo(
    () => computeVisibleProjectIndices(projects, hideDisconnected),
    [projects, hideDisconnected],
  );
  const visibleProjectIndexSet = useMemo(() => new Set(visibleProjectIndices), [visibleProjectIndices]);
  const filterLabel = hideDisconnected ? 'Show all projects' : 'Show connected only';
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [projectSearchCandidateId, setProjectSearchCandidateId] = useState<string | null>(null);
  const projectSearchInputRef = useRef<HTMLInputElement>(null);
  const projectSearchPriorFocusRef = useRef<HTMLElement | null>(null);
  const projectRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const projectSearchMatches = useMemo(() => {
    if (!projectSearchOpen || projectSearchQuery.length === 0) return [];
    return visibleProjectIndices.flatMap((index) => {
      const project = projects[index];
      if (!project) return [];
      const label = project.parentProjectId ? project.worktreeBranch : project.name;
      if (!label) return [];
      const matchIndex = findProjectSearchMatchIndex(label, projectSearchQuery);
      return matchIndex === -1 ? [] : [{ id: project.id, index, matchIndex }];
    });
  }, [projectSearchOpen, projectSearchQuery, projects, visibleProjectIndices]);
  const projectSearchMatchById = useMemo(
    () => new Map(projectSearchMatches.map((match) => [match.id, match.matchIndex])),
    [projectSearchMatches],
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Live width while dragging the resize handle; null when not resizing (then the
  // persisted settings width applies). Committed to settings on mouse-up.
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  const sidebarWidth = resizeWidth ?? settings.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Clamped on-screen position, measured after the menu mounts. Null until
  // measured → first paint falls back to the raw cursor position.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

  const closeProjectSearch = (restorePriorFocus: boolean) => {
    setProjectSearchOpen(false);
    setProjectSearchQuery('');
    setProjectSearchCandidateId(null);
    if (!restorePriorFocus) return;
    const priorFocus = projectSearchPriorFocusRef.current;
    requestAnimationFrame(() => {
      if (priorFocus?.isConnected) priorFocus.focus();
    });
  };

  const toggleProjectSearch = () => {
    if (projectSearchOpen) {
      closeProjectSearch(true);
      return;
    }
    projectSearchPriorFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setProjectSearchOpen(true);
  };

  useEffect(() => {
    if (projectSearchOpen) projectSearchInputRef.current?.focus();
  }, [projectSearchOpen]);

  useEffect(() => {
    setProjectSearchCandidateId(projectSearchMatches[0]?.id ?? null);
  }, [projectSearchMatches]);

  useEffect(() => {
    if (!projectSearchCandidateId) return;
    projectRowRefs.current.get(projectSearchCandidateId)?.scrollIntoView({ block: 'nearest' });
  }, [projectSearchCandidateId]);

  // Row-tint flash on connection-health *worsening* (a one-shot attention pulse;
  // the steady state lives in the dot colour — see §5.9). Track each project's
  // last-seen aggregate health; when it degrades, flash the row for ~1.8s.
  const prevHealthRef = useRef<Record<string, ConnectionHealthState>>({});
  const [flashingIds, setFlashingIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevHealthRef.current;
    const next: Record<string, ConnectionHealthState> = {};
    const worsened: string[] = [];
    for (const proj of projects) {
      const h = projectHealth(proj, connectionHealth);
      if (!h) continue;
      next[proj.id] = h.state;
      const before = prev[proj.id];
      if (before && HEALTH_RANK[h.state] > HEALTH_RANK[before]) worsened.push(proj.id);
    }
    prevHealthRef.current = next;
    if (worsened.length === 0) return;
    setFlashingIds((s) => new Set([...s, ...worsened]));
    const timers = worsened.map((id) =>
      setTimeout(() => setFlashingIds((s) => { const n = new Set(s); n.delete(id); return n; }), 1800),
    );
    return () => timers.forEach(clearTimeout);
  }, [projects, connectionHealth]);

  // After the menu mounts, measure it and clamp so it never spills off-screen
  // (e.g. right-clicking a project near the bottom edge). Runs before paint, so
  // the corrected position is the one the user sees — no visible jump.
  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) {
      setMenuPos(null);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    setMenuPos(
      clampMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height, window.innerWidth, window.innerHeight),
    );
  }, [contextMenu]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    const projectId = projects[index]?.id;
    if (!projectId) return;
    setContextMenu({ projectId, x: e.clientX, y: e.clientY });
  };

  const handleNewProject = () => {
    emit(Events.OPEN_FOLDER_PICKER);
  };

  const handleProjectSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const action = decideProjectSearchKey(e.key, e.nativeEvent.isComposing);
    if (action === 'none') return;
    e.preventDefault();
    if (action === 'close') {
      closeProjectSearch(true);
      return;
    }
    if (action === 'up' || action === 'down') {
      setProjectSearchCandidateId((currentId) => moveProjectSearchCandidate(
        projectSearchMatches.map((match) => match.id),
        currentId,
        action === 'up' ? -1 : 1,
      ));
      return;
    }
    const candidate = resolveProjectSearchCandidate(projectSearchMatches, projectSearchCandidateId);
    if (!candidate) return;
    const restorePriorFocus = candidate.index === activeProjectIndex;
    setActiveProject(candidate.index);
    closeProjectSearch(restorePriorFocus);
  };

  // Drag the right edge to resize. The sidebar is the leftmost pane, so the
  // cursor's clientX is the width. Track live via document listeners (the pointer
  // may leave the thin handle mid-drag) and persist once on release.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const clamp = (x: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, x));
    const onMove = (ev: MouseEvent) => setResizeWidth(clamp(ev.clientX));
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setResizeWidth(null);
      updateSettings({ sidebarWidth: clamp(ev.clientX) });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      const sourceId = projects[dragIndex]?.id;
      const targetId = projects[toIndex]?.id;
      if (sourceId && targetId) emit(Events.REORDER_PROJECTS, sourceId, targetId);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <aside className="sidebar" style={{ width: sidebarWidth }}>
      <div className="sidebar-header">
        <span>Shelf</span>
        <span className="sidebar-header-actions">
          <button className="sidebar-btn" tabIndex={-1} onMouseDown={preventButtonFocus} onClick={toggleSettings} title={tooltipWithShortcut('Settings', kb.openSettings, isMac)}>&#9881;</button>
          <button className="sidebar-btn" tabIndex={-1} onMouseDown={preventButtonFocus} onClick={handleNewProject} title={tooltipWithShortcut('New project', kb.newProject, isMac)}>+</button>
          <button
            className={`sidebar-btn${hideDisconnected ? ' active' : ''}`}
            tabIndex={-1}
            onMouseDown={preventButtonFocus}
            onClick={toggleHideDisconnected}
            title={tooltipWithShortcut(filterLabel, kb[TOGGLE_CONNECTED_FILTER_ACTION], isMac)}
            aria-label={filterLabel}
            aria-pressed={hideDisconnected}
          >
            <FilterIcon />
          </button>
          <button
            className={`sidebar-btn${projectSearchOpen ? ' active' : ''}`}
            tabIndex={-1}
            onMouseDown={preventButtonFocus}
            onClick={toggleProjectSearch}
            title="Search projects"
            aria-label="Search projects"
            aria-pressed={projectSearchOpen}
          >
            <SearchIcon />
          </button>
        </span>
      </div>
      {projectSearchOpen && (
        <div className="sidebar-project-search-row">
          <input
            ref={projectSearchInputRef}
            className="sidebar-project-search-input"
            type="text"
            value={projectSearchQuery}
            onChange={(e) => setProjectSearchQuery(e.target.value)}
            onKeyDown={handleProjectSearchKeyDown}
            placeholder="Search projects…"
            aria-label="Search projects"
          />
        </div>
      )}
      <div className="sidebar-list">
        {projects.map((proj, i) => {
          if (!visibleProjectIndexSet.has(i)) return null;
          const hasAlive = proj.tabs.length > 0;
          const isDragging = dragIndex === i;
          const isDragOver = dragOverIndex === i && dragIndex !== i;
          // Health overlays the base alive/dead dot: healthy keeps the green
          // `alive`; slow/unstable/dead recolour via `health-*` (distinct from
          // the grey base `dead` = disconnected). Tooltip carries RTT.
          const health = hasAlive ? projectHealth(proj, connectionHealth) : null;
          const healthClass = health && health.state !== 'healthy' ? ` health-${health.state}` : '';
          const healthTitle = health
            ? `Connection: ${health.state}${health.rttMs != null ? ` · ${Math.round(health.rttMs)}ms` : ''}`
            : undefined;
          const isFlashing = flashingIds.has(proj.id);
          // A worktree child renders as an indented group member showing just its
          // branch (the parent project name is redundant — the group conveys it),
          // and it cannot start a drag: the whole group moves via its parent.
          const isWorktreeChild = !!proj.parentProjectId;
          const label = projectDisplayLabel(proj);
          const searchMatchIndex = projectSearchMatchById.get(proj.id) ?? -1;
          const isSearchMatch = searchMatchIndex !== -1;
          const isSearchCandidate = projectSearchCandidateId === proj.id;
          // Another worktree of the same parent follows → the guide line keeps
          // running past this child instead of ending at its elbow.
          const nextProj = projects[i + 1];
          const hasSiblingBelow =
            isWorktreeChild && !!nextProj && nextProj.parentProjectId === proj.parentProjectId;

          return (
            <div
              key={proj.id}
              ref={(element) => {
                if (element) projectRowRefs.current.set(proj.id, element);
                else projectRowRefs.current.delete(proj.id);
              }}
              className={`sidebar-item ${i === activeProjectIndex ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}${isFlashing ? ' health-flash' : ''}${isWorktreeChild ? ' worktree-child' : ''}${isWorktreeUnavailable(proj) ? ' worktree-missing' : ''}${hasSiblingBelow ? ' has-sibling-below' : ''}${isSearchMatch ? ' project-search-match' : ''}${isSearchCandidate ? ' project-search-candidate' : ''}`}
              onClick={() => { setActiveProject(i); if (projectSearchOpen) closeProjectSearch(false); }}
              onContextMenu={(e) => { if (isWorktreeUnavailable(proj)) { e.preventDefault(); return; } setActiveProject(i); if (projectSearchOpen) closeProjectSearch(false); handleContextMenu(e, i); }}
              draggable={!isWorktreeChild}
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
            >
              <span className={`status-dot ${hasAlive ? 'alive' : 'dead'}${healthClass}`} title={healthTitle} />
              <span className="project-name-group">
                <span className="project-name">
                  {isSearchMatch && label ? (
                    <>
                      {label.slice(0, searchMatchIndex)}
                      <mark className="project-search-match-text">
                        {label.slice(searchMatchIndex, searchMatchIndex + projectSearchQuery.length)}
                      </mark>
                      {label.slice(searchMatchIndex + projectSearchQuery.length)}
                    </>
                  ) : label}
                </span>
                {!proj.parentProjectId && <WorktreeScanWarning projectId={proj.id} />}
              </span>
            </div>
          );
        })}
      </div>

      <div
        className={`sidebar-resize-handle${resizeWidth !== null ? ' resizing' : ''}`}
        onMouseDown={startResize}
        title="Drag to resize"
      />

      {contextMenu && (() => {
        const proj = projects.find((p) => p.id === contextMenu.projectId);
        if (proj && isWorktreeUnavailable(proj)) return null;
        const isConnected = proj && proj.tabs.length > 0;
        const isInvalid = proj?.folderInvalid;
        return (
          <div
            ref={menuRef}
            className="context-menu"
            style={{ top: menuPos?.top ?? contextMenu.y, left: menuPos?.left ?? contextMenu.x }}
          >
            {isConnected ? (
              <button
                className="context-menu-item"
                onClick={() => { emit(Events.DISCONNECT_PROJECT, contextMenu.projectId); setContextMenu(null); }}
              >
                Disconnect
              </button>
            ) : (
              <button
                className="context-menu-item"
                disabled={isInvalid}
                onClick={() => { emit(Events.CONNECT_PROJECT, contextMenu.projectId); setContextMenu(null); }}
              >
                Connect
              </button>
            )}
            {!proj?.parentProjectId && (
              <button
                className="context-menu-item"
                disabled={isInvalid}
                onClick={() => { emit(Events.CREATE_WORKTREE, contextMenu.projectId); setContextMenu(null); }}
              >
                New Worktree
              </button>
            )}
            <button
              className="context-menu-item"
              onClick={() => { setEditingProjectById(contextMenu.projectId); setContextMenu(null); }}
            >
              Edit
            </button>
            <div className="context-menu-separator" />
            {proj?.parentProjectId ? (
              // A worktree child closes via Finish (ff merge-back) or Abandon
              // (discard) — both user-initiated (#lifecycle). Plain Remove would
              // orphan the git worktree + branch, so it's replaced here.
              <>
                <button
                  className="context-menu-item"
                  onClick={() => { emit(Events.WORKTREE_CLOSE, contextMenu.projectId, 'finish'); setContextMenu(null); }}
                >
                  Finish
                </button>
                <button
                  className="context-menu-item context-menu-item-danger"
                  onClick={() => { emit(Events.WORKTREE_CLOSE, contextMenu.projectId, 'abandon'); setContextMenu(null); }}
                >
                  Abandon
                </button>
              </>
            ) : (
              <button
                className="context-menu-item context-menu-item-danger"
                onClick={() => { emit(CONFIRM_REMOVE_EVENT, contextMenu.projectId); setContextMenu(null); }}
              >
                Remove
              </button>
            )}
          </div>
        );
      })()}
    </aside>
  );
}
