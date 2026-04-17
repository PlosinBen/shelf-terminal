import { useEffect } from 'react';
import {
  toggleSidebar,
  toggleSettings,
  toggleSearch,
  toggleCommandPicker,
  toggleDevTools,
  setActiveProject,
  setActiveTab,
  useStore,
} from '../store';
import { emit, Events } from '../events';
import type { KeybindingAction } from '@shared/types';

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
    // mod+1~9 → switchTab_N
    for (let n = 1; n <= 9; n++) {
      comboToAction.set(`mod+${n}`, `switchTab_${n}` as KeybindingAction);
    }

    const handler = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      const raw = comboToAction.get(combo);
      if (!raw) return;

      const [action, ...params] = (raw as string).split('_');
      const activeProject = projects[activeProjectIndex];

      const fn = ((): (() => void) | null => {
        switch (action) {
          case 'toggleSidebar':  return toggleSidebar;
          case 'openSettings':   return toggleSettings;
          case 'search':         return toggleSearch;
          case 'openCommandPicker': return activeProject ? toggleCommandPicker : null;
          case 'toggleDevTools':   return toggleDevTools;
          case 'newProject':     return () => emit(Events.OPEN_FOLDER_PICKER);
          case 'prevProject':    return () => setActiveProject(Math.max(0, activeProjectIndex - 1));
          case 'nextProject':    return () => setActiveProject(Math.min(projects.length - 1, activeProjectIndex + 1));
          case 'removeProject':   return activeProject ? () => emit(Events.REMOVE_PROJECT, activeProjectIndex) : null;
          case 'newTab':         return activeProject ? () => emit(Events.NEW_TAB, activeProjectIndex) : null;
          case 'toggleSplit':    return activeProject ? () => emit(Events.TOGGLE_SPLIT, activeProjectIndex) : null;
          case 'prevTab':        return activeProject ? () => setActiveTab(activeProjectIndex, Math.max(0, activeProject.activeTabIndex - 1)) : null;
          case 'nextTab':        return activeProject ? () => setActiveTab(activeProjectIndex, Math.min(activeProject.tabs.length - 1, activeProject.activeTabIndex + 1)) : null;
          case 'switchTab': {
            const index = parseInt(params[0], 10) - 1;
            return activeProject && index >= 0 && index < activeProject.tabs.length
              ? () => setActiveTab(activeProjectIndex, index)
              : null;
          }
          default: return null;
        }
      })();

      if (fn) {
        e.preventDefault();
        e.stopPropagation();
        fn();
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
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
