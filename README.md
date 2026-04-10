# Shelf Terminal

Cross-platform, project-based terminal manager built with Electron. Replaces tmux for multi-project CLI management.

## Features

- **Project-based** — each project binds to a folder, with multiple terminal tabs
- **Lazy connect** — projects load without auto-connecting; click or press Enter to open terminal
- **Terminal tabs** — per-project tabs backed by real pty processes (node-pty + xterm.js)
- **Split pane** — left/right split within a project (mod+\\)
- **SSH / WSL** — connect to remote hosts via SSH (ControlMaster multiplexing, password auth) or WSL (distro dropdown)
- **Themes** — 5 built-in themes (Catppuccin Mocha/Latte, Dracula, Nord, Tokyo Night)
- **Terminal search** — search scrollback buffer (mod+F)
- **Tab management** — double-click to rename, drag to reorder, mod+1~9 to switch
- **Tab badge** — unread indicator on background tabs with new output
- **Project management** — drag to reorder, right-click context menu (Edit, Connect/Disconnect, Close)
- **Init script** — per-project startup commands (e.g. `nvm use 22`, `conda activate`)
- **Default tabs** — per-project tab templates with individual commands, auto-opened on connect
- **Custom keybindings** — all shortcuts configurable via Settings panel
- **File paste / drag-drop** — drop or paste any file into the terminal; Shelf uploads it to `<projectCwd>/.tmp/shelf/` (works for local, SSH, WSL, Docker) and types the path
- **Background notifications** — system notification when long-running commands finish
- **Settings** — font, theme, scrollback, keybindings, log level, persisted to `settings.json`
- **Logging** — date-based log files, configurable level (off/error/info/debug), `LOG_LEVEL` env override
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

## Note

Shelf Terminal is a terminal wrapper — it does not install, configure, or authenticate any CLI tools. Any tools you want to use (nvm, conda, docker, claude, gh, etc.) must be set up independently. Shelf simply provides the terminal environment to run them in.

## Usage

### Init Script

Per-project commands that run automatically when the terminal connects. Set via right-click project → Edit.

Example: `nvm use 22 && conda activate myenv`

Useful for environment setup that you'd otherwise type every time you open a terminal.

### Default Tabs

Pre-define tabs that auto-open on connect, each with its own command. Set via right-click project → Edit.

Example: a `dev` tab running `npm run dev`, a `test` tab running `npm run test:watch`, and a plain `shell` tab with no command.

### SSH with Shared Connection

Multiple tabs to the same SSH host share a single TCP connection (ControlMaster). Open 5 tabs — authenticate once.

### File Paste & Drag-Drop

Paste or drag any file (image, PDF, archive, log, …) into the terminal. Shelf uploads it to `<projectCwd>/.tmp/shelf/<prefix>-<filename>` and types the shell-quoted path into the terminal input.

- Works for **local, SSH, Docker, and WSL** projects through one unified path. SSH/Docker/WSL streams the buffer over `sh -c "cat > …"` (no scp/docker-cp staging files).
- The destination lives inside the project directory so sandboxed agent CLIs (Claude Code, Gemini, Codex, …) that are restricted to the project can still read the file.
- Multi-file drops are uploaded in parallel and the resulting paths are inserted on a single line, space-separated.
- Files exceeding **Max Upload Size (MB)** in Settings (default 50) are skipped and reported via a popup; the rest still go through.
- A `.tmp/.gitignore` (`*`) is dropped on first upload so the directory stays out of git.
- **Auto-cleanup**: a few seconds after a project's first tab opens, leftover uploads from previous Shelf sessions are deleted in the background. Files created in the current session are never touched (the cutoff is decoded from each file's own timestamp prefix). Use **Edit Project → Clear uploaded files** for a manual purge — the button is disabled with a hint when the remote is not currently connected.

### Background Notification

When a command runs for more than 5 seconds and finishes while Shelf is not focused, a system notification appears. Only triggers after user keyboard input — background output from agent CLIs won't spam notifications.

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
e2e/              # Playwright E2E tests (25 tests)
```

## Testing

```bash
# Run all E2E tests (builds first)
npm run test:e2e
```

## macOS — Unsigned App

The app is not code-signed. On first launch macOS will block it. To open:

1. Right-click `Shelf.app` → Open (or System Settings → Privacy & Security → Open Anyway)
2. Or run: `xattr -cr /Applications/Shelf.app`

## Settings

Stored at `~/Library/Application Support/shelf-terminal/settings.json` (macOS) or `~/.config/shelf-terminal/` (Linux/Windows).

Projects stored at the same location in `projects.json`.

Dev and test environments use isolated paths (`shelf-terminal-development`, `shelf-terminal-test`).

## License

MIT
