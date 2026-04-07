import { useEffect } from 'react';
import {
  toggleSidebar,
  toggleSettings,
  setActiveProject,
  setActiveTab,
  addTab,
  removeProject,
  useStore,
} from '../store';

const isMac = navigator.platform.toUpperCase().includes('MAC');

function isModKey(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

export function useKeybindings() {
  const { projects, activeProjectIndex } = useStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isModKey(e)) return;

      const activeProject = projects[activeProjectIndex];

      switch (e.key) {
        case 'b':
        case 'B':
          e.preventDefault();
          toggleSidebar();
          break;

        case 'o':
        case 'O':
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('shelf:open-folder-picker'));
          break;

        case 'w':
        case 'W':
          if (activeProject) {
            e.preventDefault();
            activeProject.tabs.forEach((tab) => {
              window.shelfApi.pty.kill(tab.id);
            });
            removeProject(activeProjectIndex);
          }
          break;

        case 't':
        case 'T':
          if (activeProject) {
            e.preventDefault();
            const tab = addTab(activeProjectIndex);
            if (tab) {
              window.shelfApi.pty.spawn(activeProject.config.id, tab.id, activeProject.config.cwd, activeProject.config.connection);
            }
          }
          break;

        case 'ArrowUp':
          e.preventDefault();
          setActiveProject(Math.max(0, activeProjectIndex - 1));
          break;

        case 'ArrowDown':
          e.preventDefault();
          setActiveProject(Math.min(projects.length - 1, activeProjectIndex + 1));
          break;

        case '[':
          if (e.shiftKey && activeProject) {
            e.preventDefault();
            setActiveTab(activeProjectIndex, Math.max(0, activeProject.activeTabIndex - 1));
          }
          break;

        case ']':
          if (e.shiftKey && activeProject) {
            e.preventDefault();
            setActiveTab(
              activeProjectIndex,
              Math.min(activeProject.tabs.length - 1, activeProject.activeTabIndex + 1),
            );
          }
          break;

        case ',':
          e.preventDefault();
          toggleSettings();
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [projects, activeProjectIndex]);
}
