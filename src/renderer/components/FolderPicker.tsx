import React, { useState, useEffect, useCallback, useRef } from 'react';
import { addProject, getProjectConfigs } from '../store';
import { FolderBrowser } from './FolderBrowser';
import type { ProjectConfig } from '../../shared/types';

export function FolderPicker() {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const listRef = useRef<HTMLDivElement>(null);
  const filteredRef = useRef<string[]>([]);
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  // ── Filtered entries ──
  const filtered = filter
    ? entries.filter((name) => name.toLowerCase().includes(filter.toLowerCase()))
    : entries;
  filteredRef.current = filtered;

  // ── Folder loading ──
  const requestFolder = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    setFilter('');
    setSelectedIndex(0);

    try {
      const result = await window.shelfApi.folder.list(dirPath);
      setCurrentPath(result.path);
      setEntries(result.entries);
      setError(result.error ?? null);
    } catch {
      setError('Failed to list folders');
    } finally {
      setLoading(false);
    }
  }, []);

  const goUp = useCallback(() => {
    const parent = currentPathRef.current.replace(/\/[^/]+\/?$/, '') || '/';
    if (parent !== currentPathRef.current) {
      requestFolder(parent);
    }
  }, [requestFolder]);

  // ── Open handler ──
  useEffect(() => {
    const handler = async () => {
      setOpen(true);
      const home = await window.shelfApi.folder.homePath();
      requestFolder(home);
    };
    window.addEventListener('shelf:open-folder-picker', handler);
    return () => window.removeEventListener('shelf:open-folder-picker', handler);
  }, [requestFolder]);

  // ── Reset selection when filter changes ──
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // ── Scroll selected into view ──
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // +1 because first child is the ".." item
    const item = list.children[selectedIndex + 1] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // ── Select and close ──
  const handleSelect = async () => {
    const entry = filteredRef.current[selectedIndexRef.current];
    const selectedPath = entry
      ? `${currentPathRef.current}/${entry}`
      : currentPathRef.current;

    const folderName = selectedPath.split('/').filter(Boolean).pop() || 'project';
    const config: ProjectConfig = {
      id: `proj-${Date.now()}`,
      name: folderName,
      cwd: selectedPath,
      connection: { type: 'local' },
      maxTabs: 5,
    };

    addProject(config);
    const configs = getProjectConfigs();
    await window.shelfApi.project.save(configs);
    setOpen(false);
  };

  const handleCancel = () => setOpen(false);

  // ── Keyboard navigation ──
  useEffect(() => {
    if (!open) return;

    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(-1, i - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(filteredRef.current.length - 1, i + 1));
          break;
        case 'ArrowRight': {
          e.preventDefault();
          if (selectedIndexRef.current === -1) {
            goUp();
            return;
          }
          const entry = filteredRef.current[selectedIndexRef.current];
          if (entry) requestFolder(currentPathRef.current + '/' + entry);
          break;
        }
        case 'ArrowLeft':
          e.preventDefault();
          goUp();
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedIndexRef.current === -1) {
            goUp();
          } else {
            handleSelect();
          }
          break;
        case 'Escape':
          e.preventDefault();
          handleCancel();
          break;
        case 'Backspace':
          e.preventDefault();
          setFilter((f) => f.slice(0, -1));
          break;
        default:
          // Printable single characters → filter
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            setFilter((f) => f + e.key);
          }
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, goUp, requestFolder]);

  if (!open) return null;

  return (
    <div className="folder-picker-overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) handleCancel();
    }}>
      <div className="folder-picker">
        <div className="fp-header">Open Project</div>
        <FolderBrowser
          currentPath={currentPath}
          filtered={filtered}
          selectedIndex={selectedIndex}
          filter={filter}
          loading={loading}
          error={error}
          listRef={listRef}
          onSelectIndex={setSelectedIndex}
          onNavigate={requestFolder}
          onGoUp={goUp}
        />
      </div>
    </div>
  );
}
