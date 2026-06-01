import type { AppSettings, KeybindingConfig } from './types';

export const DEFAULT_KEYBINDINGS: KeybindingConfig = {
  toggleProjectList: 'mod+shift+b',
  newProject: 'mod+o',
  removeProject: 'mod+w',
  newTab: 'mod+t',
  prevProject: 'mod+ArrowUp',
  nextProject: 'mod+ArrowDown',
  prevTab: 'mod+shift+[',
  nextTab: 'mod+shift+]',
  openSettings: 'mod+,',
  search: 'mod+f',
  toggleSplitRight: 'mod+shift+\\',
  openCommandPicker: 'mod+e',
  toggleDevTools: 'mod+shift+d',
  toggleNotes: 'mod+shift+n',
  togglePm: 'mod+shift+m',
  quickNote: 'mod+n',
};

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  themeName: 'catppuccin-mocha',
  scrollback: 5000,
  defaultMaxTabs: 5,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  logLevel: 'error' as const,
  maxUploadSizeMB: 50,
  agentInMemoryMaxMessages: 500,
  agentHistorySaveThrottleMs: 5000,
};
