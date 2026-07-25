import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  useStore,
  setActiveProject,
  setEditingProject,
  toggleSettings,
  reorderProjects,
  updateSettings,
  projectHealth,
  HEALTH_RANK,
} from '../store';
import type { ConnectionHealthState } from '@shared/types';
import { emit, Events } from '../events';
import { CONFIRM_REMOVE_EVENT } from './RemoveConfirmDialog';
import { tooltipWithShortcut } from '../utils/format-keybinding';
import { isMac } from '../hooks/useKeybindings';

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

export function Sidebar() {
  const { projects, activeProjectIndex, settings, connectionHealth } = useStore();
  const kb = settings.keybindings;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Live width while dragging the resize handle; null when not resizing (then the
  // persisted settings width applies). Committed to settings on mouse-up.
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  const sidebarWidth = resizeWidth ?? settings.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Clamped on-screen position, measured after the menu mounts. Null until
  // measured → first paint falls back to the raw cursor position.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

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
      next[proj.config.id] = h.state;
      const before = prev[proj.config.id];
      if (before && HEALTH_RANK[h.state] > HEALTH_RANK[before]) worsened.push(proj.config.id);
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
    setContextMenu({ index, x: e.clientX, y: e.clientY });
  };

  const handleNewProject = () => {
    emit(Events.OPEN_FOLDER_PICKER);
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
      reorderProjects(dragIndex, toIndex);
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
          <button className="sidebar-btn" tabIndex={-1} onClick={toggleSettings} title={tooltipWithShortcut('Settings', kb.openSettings, isMac)}>&#9881;</button>
          <button className="sidebar-btn" tabIndex={-1} onClick={handleNewProject} title={tooltipWithShortcut('New project', kb.newProject, isMac)}>+</button>
        </span>
      </div>
      <div className="sidebar-list">
        {projects.map((proj, i) => {
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
          const isFlashing = flashingIds.has(proj.config.id);
          // A worktree child renders as an indented group member showing just its
          // branch (the parent project name is redundant — the group conveys it),
          // and it cannot start a drag: the whole group moves via its parent.
          const isWorktreeChild = !!proj.config.parentProjectId;
          const label = isWorktreeChild ? proj.config.worktreeBranch : proj.config.name;
          // Another worktree of the same parent follows → the guide line keeps
          // running past this child instead of ending at its elbow.
          const nextProj = projects[i + 1];
          const hasSiblingBelow =
            isWorktreeChild && !!nextProj && nextProj.config.parentProjectId === proj.config.parentProjectId;

          return (
            <div
              key={proj.config.id}
              className={`sidebar-item ${i === activeProjectIndex ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}${isFlashing ? ' health-flash' : ''}${isWorktreeChild ? ' worktree-child' : ''}${hasSiblingBelow ? ' has-sibling-below' : ''}`}
              onClick={() => setActiveProject(i)}
              onContextMenu={(e) => { setActiveProject(i); handleContextMenu(e, i); }}
              draggable={!isWorktreeChild}
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
            >
              <span className={`status-dot ${hasAlive ? 'alive' : 'dead'}${healthClass}`} title={healthTitle} />
              <span className="project-name-group">
                <span className="project-name">{label}</span>
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
        const proj = projects[contextMenu.index];
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
                onClick={() => { emit(Events.DISCONNECT_PROJECT, contextMenu.index); setContextMenu(null); }}
              >
                Disconnect
              </button>
            ) : (
              <button
                className="context-menu-item"
                disabled={isInvalid}
                onClick={() => { emit(Events.CONNECT_PROJECT, contextMenu.index); setContextMenu(null); }}
              >
                Connect
              </button>
            )}
            {!proj?.config.parentProjectId && (
              <button
                className="context-menu-item"
                disabled={isInvalid}
                onClick={() => { emit(Events.CREATE_WORKTREE, contextMenu.index); setContextMenu(null); }}
              >
                New Worktree
              </button>
            )}
            <button
              className="context-menu-item"
              onClick={() => { setEditingProject(contextMenu.index); setContextMenu(null); }}
            >
              Edit
            </button>
            <div className="context-menu-separator" />
            <button
              className="context-menu-item context-menu-item-danger"
              onClick={() => { emit(CONFIRM_REMOVE_EVENT, contextMenu.index); setContextMenu(null); }}
            >
              Remove
            </button>
          </div>
        );
      })()}
    </aside>
  );
}
