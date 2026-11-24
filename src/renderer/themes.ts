import type { ITheme } from '@xterm/xterm';

export interface ShelfTheme {
  name: string;
  label: string;
  terminal: ITheme;
  semantic?: Partial<Record<keyof typeof SEMANTIC_TOKENS, string>>;
  ui: {
    bg: string;
    bgSecondary: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    onAccent: string;
    surface: string;
  };
}

const catppuccinMocha: ShelfTheme = {
  name: 'catppuccin-mocha',
  label: 'Catppuccin Mocha',
  terminal: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b70',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  ui: {
    bg: '#1e1e2e',
    bgSecondary: '#181825',
    border: '#313244',
    text: '#cdd6f4',
    textMuted: '#a6adc8',
    accent: '#89b4fa',
    onAccent: '#1e1e2e',
    surface: '#313244',
  },
};

const catppuccinLatte: ShelfTheme = {
  name: 'catppuccin-latte',
  label: 'Catppuccin Latte',
  semantic: {
    error: '#992139', success: '#315d25', warning: '#714900', info: '#215688',
    foldLabel: '#70408c', statusHealthy: '#315d25', statusSlow: '#714900',
    statusUnstable: '#984313', statusDead: '#992139',
  },
  terminal: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    selectionBackground: '#acb0be',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#acb0be',
    brightBlack: '#6c6f85',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#ea76cb',
    brightCyan: '#179299',
    brightWhite: '#bcc0cc',
  },
  ui: {
    bg: '#eff1f5',
    bgSecondary: '#e6e9ef',
    border: '#ccd0da',
    text: '#4c4f69',
    textMuted: '#53576c',
    accent: '#1e66f5',
    onAccent: '#ffffff',
    surface: '#ccd0da',
  },
};

const dracula: ShelfTheme = {
  name: 'dracula',
  label: 'Dracula',
  terminal: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  ui: {
    bg: '#282a36',
    bgSecondary: '#21222c',
    border: '#44475a',
    text: '#f8f8f2',
    textMuted: '#b1bada',
    accent: '#bd93f9',
    onAccent: '#21222c',
    surface: '#44475a',
  },
};

const nord: ShelfTheme = {
  name: 'nord',
  label: 'Nord',
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  ui: {
    bg: '#2e3440',
    bgSecondary: '#292e39',
    border: '#3b4252',
    text: '#d8dee9',
    textMuted: '#a4b0c2',
    accent: '#81a1c1',
    onAccent: '#20252e',
    surface: '#3b4252',
  },
};

const tokyoNight: ShelfTheme = {
  name: 'tokyo-night',
  label: 'Tokyo Night',
  terminal: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    selectionBackground: '#33467c',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  ui: {
    bg: '#1a1b26',
    bgSecondary: '#16161e',
    border: '#292e42',
    text: '#c0caf5',
    textMuted: '#9aa5ce',
    accent: '#7aa2f7',
    onAccent: '#1a1b26',
    surface: '#292e42',
  },
};

export const themes: ShelfTheme[] = [
  catppuccinMocha,
  catppuccinLatte,
  dracula,
  nord,
  tokyoNight,
];

export function getTheme(name: string): ShelfTheme {
  const theme = themes.find((t) => t.name === name) ?? catppuccinMocha;
  if (!theme.terminal.scrollbarSliderBackground) {
    theme.terminal.scrollbarSliderBackground = theme.ui.border;
    theme.terminal.scrollbarSliderHoverBackground = theme.ui.textMuted;
    theme.terminal.scrollbarSliderActiveBackground = theme.ui.textMuted;
  }
  return theme;
}

/**
 * Default semantic colors. Themes can override individual roles for contrast.
 */
export const SEMANTIC_TOKENS = {
  error: '#e06c75',
  success: '#98c379',
  warning: '#e5c07b',
  info: '#61afef',
  foldLabel: '#c678dd',
  userBubble: 'rgba(229, 192, 123, 0.15)',
  // Project/connection status-dot colours (Sidebar). Deliberately a SEPARATE
  // palette from the agent-status `--agent-*` severity colours: the project dot
  // expresses connection health as a warm healthy→dead heat gradient, which is
  // its own visual language, not the agent status bar's info/warn/error one.
  statusHealthy: '#a6e3a1',
  statusSlow: '#f9e2af',
  statusUnstable: '#fab387',
  statusDead: '#f38ba8',
} as const;

/**
 * The single serializable derivation of a theme into a flat CSS-variable map.
 * App.tsx feeds this to `documentElement.style.setProperty`; a future native /
 * webview host (R4) consumes the same plain `Record<string,string>` — no second
 * copy of the token→var mapping. Per-theme `ui` + shared `SEMANTIC_TOKENS`.
 */
export function buildThemeVars(theme: ShelfTheme): Record<string, string> {
  const semantic = { ...SEMANTIC_TOKENS, ...theme.semantic };
  return {
    '--bg': theme.ui.bg,
    '--bg-secondary': theme.ui.bgSecondary,
    '--border': theme.ui.border,
    '--text': theme.ui.text,
    '--text-muted': theme.ui.textMuted,
    '--accent': theme.ui.accent,
    '--on-accent': theme.ui.onAccent,
    '--surface': theme.ui.surface,
    '--agent-error': semantic.error,
    '--agent-success': semantic.success,
    '--agent-warning': semantic.warning,
    '--agent-info': semantic.info,
    '--agent-fold-label': semantic.foldLabel,
    '--agent-user-bubble': semantic.userBubble,
    // Project status-dot palette — separate namespace from `--agent-*`.
    '--status-healthy': semantic.statusHealthy,
    '--status-slow': semantic.statusSlow,
    '--status-unstable': semantic.statusUnstable,
    '--status-dead': semantic.statusDead,
  };
}
