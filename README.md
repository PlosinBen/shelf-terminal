# Shelf Terminal

Cross-platform, project-based terminal manager built with Electron. Replaces tmux for multi-project CLI management.

## Features

- **Project-based** — each project binds to a folder, with multiple terminal tabs
- **Lazy connect** — projects load without auto-connecting; click or press Enter to open terminal
- **Terminal tabs** — per-project tabs backed by real pty processes (node-pty + xterm.js)
- **Split pane** — left/right split within a project (mod+\\)
- **SSH / WSL** — connect to remote hosts via SSH (ControlMaster multiplexing) or WSL
- **Themes** — 5 built-in themes (Catppuccin Mocha/Latte, Dracula, Nord, Tokyo Night)
- **Terminal search** — search scrollback buffer (mod+F)
- **Tab management** — double-click to rename, drag to reorder, mod+1~9 to switch
- **Tab badge** — unread indicator on background tabs with new output
- **Project management** — drag to reorder, right-click context menu (Edit, Connect/Disconnect, Close)
- **Init script** — per-project startup commands (e.g. `nvm use 22`, `conda activate`)
- **Custom keybindings** — all shortcuts configurable via Settings panel
- **Image paste** — paste screenshots into terminal as temp file paths (SCP for SSH sessions)
- **Background notifications** — system notification when long-running commands finish
- **Settings** — font, theme, scrollback, keybindings, persisted to `settings.json`
- **Auto-updater** — checks GitHub Releases, user confirms before downloading

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 41 |
| Terminal | node-pty 1.1 + @xterm/xterm 6.0 |
| UI | React 19 + TypeScript 5.9 |
| Build | Vite 6.4 + vite-plugin-electron |
| Package | electron-builder |
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

# Package for distribution
npm run dist:mac    # macOS (.dmg, .zip)
npm run dist:win    # Windows (.exe, .zip)
npm run dist:linux  # Linux (.AppImage, .deb)
```

## Keyboard Shortcuts

`mod` = Cmd (macOS) / Ctrl (Windows/Linux). All shortcuts are customizable in Settings.

| Action | Default |
|--------|---------|
| Toggle sidebar | `mod+B` |
| New project | `mod+O` |
| Close project | `mod+W` |
| New tab | `mod+T` |
| Switch tab | `mod+1~9` |
| Previous/Next tab | `mod+Shift+[/]` |
| Switch project | `mod+Up/Down` |
| Toggle split pane | `mod+\` |
| Search | `mod+F` |
| Settings | `mod+,` |

## Project Structure

```
src/
  main/           # Electron main process, pty management, IPC handlers
  renderer/       # React UI, xterm.js, store, themes, event bus
  shared/         # Type definitions, IPC channels, defaults
e2e/              # Playwright E2E tests (16 tests)
```

## Testing

```bash
# Run all E2E tests (builds first)
npm run test:e2e
```

## Settings

Stored at `~/Library/Application Support/shelf-terminal/settings.json` (macOS) or `~/.config/shelf-terminal/` (Linux/Windows).

Projects stored at the same location in `projects.json`.

Dev and test environments use isolated paths (`shelf-terminal-development`, `shelf-terminal-test`).

## License

MIT
