import { useEffect } from 'react';
import {
  toggleSidebar,
  toggleSettings,
  toggleSearch,
  setActiveProject,
  setActiveTab,
  addTab,
  useStore,
} from '../store';
import { emit, Events } from '../events';
import type { KeybindingAction } from '../../shared/types';

const isMac = navigator.platform.toUpperCase().includes('MAC');

function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) {
    parts.push(key);
  }
  return parts.join('+');
}

export function useKeybindings() {
  const { projects, activeProjectIndex, settings } = useStore();
  const bindings = settings.keybindings;

  useEffect(() => {
    // Build reverse map: combo → action
    const comboToAction = new Map<string, KeybindingAction>();
    for (const [action, combo] of Object.entries(bindings)) {
      comboToAction.set(combo, action as KeybindingAction);
    }

    const handler = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      const action = comboToAction.get(combo);
      if (!action) return;

      const activeProject = projects[activeProjectIndex];

      switch (action) {
        case 'toggleSidebar':
          e.preventDefault();
          toggleSidebar();
          break;

        case 'newProject':
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('shelf:open-folder-picker'));
          break;

        case 'closeProject':
          if (activeProject) {
            e.preventDefault();
            emit(Events.CLOSE_PROJECT, activeProjectIndex);
          }
          break;

        case 'newTab':
          if (activeProject) {
            e.preventDefault();
            const tab = addTab(activeProjectIndex);
            if (tab) {
              window.shelfApi.pty.spawn(activeProject.config.id, tab.id, activeProject.config.cwd, activeProject.config.connection, activeProject.config.initScript);
            }
          }
          break;

        case 'prevProject':
          e.preventDefault();
          setActiveProject(Math.max(0, activeProjectIndex - 1));
          break;

        case 'nextProject':
          e.preventDefault();
          setActiveProject(Math.min(projects.length - 1, activeProjectIndex + 1));
          break;

        case 'prevTab':
          if (activeProject) {
            e.preventDefault();
            setActiveTab(activeProjectIndex, Math.max(0, activeProject.activeTabIndex - 1));
          }
          break;

        case 'nextTab':
          if (activeProject) {
            e.preventDefault();
            setActiveTab(
              activeProjectIndex,
              Math.min(activeProject.tabs.length - 1, activeProject.activeTabIndex + 1),
            );
          }
          break;

        case 'openSettings':
          e.preventDefault();
          toggleSettings();
          break;

        case 'search':
          e.preventDefault();
          toggleSearch();
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [projects, activeProjectIndex, bindings]);
}

// Utility: convert a combo string to display label
export function comboToLabel(combo: string): string {
  return combo
    .split('+')
    .map((part) => {
      if (part === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (part === 'shift') return isMac ? '⇧' : 'Shift';
      if (part === 'alt') return isMac ? '⌥' : 'Alt';
      if (part === 'ArrowUp') return '↑';
      if (part === 'ArrowDown') return '↓';
      if (part === '[') return '[';
      if (part === ']') return ']';
      return part.toUpperCase();
    })
    .join(isMac ? '' : '+');
}

// Utility: record a key combo from a KeyboardEvent (for the settings UI)
export function recordCombo(e: KeyboardEvent): string | null {
  // Ignore bare modifier presses
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null;
  return eventToCombo(e);
}
