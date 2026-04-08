import type { AppSettings, KeybindingConfig } from './types';

export const DEFAULT_KEYBINDINGS: KeybindingConfig = {
  toggleSidebar: 'mod+b',
  newProject: 'mod+o',
  closeProject: 'mod+w',
  newTab: 'mod+t',
  prevProject: 'mod+ArrowUp',
  nextProject: 'mod+ArrowDown',
  prevTab: 'mod+shift+[',
  nextTab: 'mod+shift+]',
  openSettings: 'mod+,',
  search: 'mod+f',
  toggleSplit: 'mod+\\',
};

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  themeName: 'catppuccin-mocha',
  scrollback: 5000,
  defaultMaxTabs: 5,
  keybindings: { ...DEFAULT_KEYBINDINGS },
};
