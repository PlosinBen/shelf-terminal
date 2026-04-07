# Shelf Terminal

Cross-platform, project-based terminal manager built with Electron. Replaces tmux for multi-project CLI management.

## Features

- **Project-based** — each project binds to a folder, with multiple terminal tabs
- **Terminal tabs** — per-project tabs backed by real pty processes (node-pty + xterm.js)
- **SSH / WSL** — connect to remote hosts via SSH (ControlMaster multiplexing) or WSL
- **Themes** — 5 built-in themes (Catppuccin Mocha/Latte, Dracula, Nord, Tokyo Night)
- **Settings** — font size, font family, scrollback, theme, persisted to `settings.json`
- **Image paste** — paste screenshots into terminal as temp file paths (SCP for SSH sessions)
- **Tab management** — double-click to rename, drag to reorder
- **Keyboard-driven** — configurable shortcuts for all common actions
- **App restart recovery** — projects restored on relaunch with fresh shell tabs

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 41 |
| Terminal | node-pty 1.1 + @xterm/xterm 6.0 |
| UI | React 19 + TypeScript 5.9 |
| Build | Vite 6.4 + vite-plugin-electron |
| Test | Playwright (Electron) |

## Quick Start

```bash
# Requires Node.js 22+
nvm use 22

# Install dependencies (includes electron-rebuild for node-pty)
npm install

# Development
npm run dev

# Production build
npm run build
```

## Keyboard Shortcuts

`mod` = Cmd (macOS) / Ctrl (Windows/Linux)

| Action | Shortcut |
|--------|----------|
| Toggle sidebar | `mod+B` |
| New project | `mod+O` |
| Close project | `mod+W` |
| New tab | `mod+T` |
| Switch project | `mod+Up/Down` |
| Switch tab | `mod+Shift+[/]` |
| Settings | `mod+,` |

## Project Structure

```
src/
  main/           # Electron main process, pty management, IPC handlers
  renderer/       # React UI, xterm.js, store, themes
  shared/         # Type definitions, IPC channels, defaults
e2e/              # Playwright E2E tests
```

## Testing

```bash
# Run all E2E tests (builds first)
npm run test:e2e

# Headed mode (visible Electron window)
npm run test:e2e:headed
```

## Settings

Stored at `~/.config/shelf-terminal/settings.json` (macOS: `~/Library/Application Support/shelf-terminal/`).

Projects stored at the same location in `projects.json`.

## License

MIT
