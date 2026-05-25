# Shelf Terminal

> 中文版：[README-zhtw.md](./README-zhtw.md)

Cross-platform, project-based terminal manager built with Electron. Replaces tmux for multi-project CLI management.

## What Shelf Is

Shelf is a project-based terminal manager — open 10+ terminals across multiple projects without spending mental energy on window/session housekeeping. It's a spiritual successor to tmux + session-management plugins, aimed at being more comfortable than that route. The agent view (Claude Code / Copilot CLI etc.) is a bonus, not the headline feature.

## Why I Built This

I used tmux heavily for years, but managing windows and sessions became painful as my project count grew. Saving window state required plugins, and finding things still hurt. On a typical workday I have 10+ terminals open — even more since vibing CLI tools (Claude Code, Copilot CLI) entered my workflow. That overhead became a daily tax.

My workflow shifted in this period too. I used to split time between terminal and JetBrains IDE; vibing pushed me toward CLI-first, with the IDE demoted to a code viewer. Once the terminal stopped being a sidekick and became the main stage, its ergonomics turned into a critical pain point.

The agent view was a separate motivation. CLI agents like Claude Code and Copilot CLI are powerful, but their input area is weak — multi-line editing, going back to fix text, pasting long prompts all behave differently from what people expect from a normal editor. I wanted "the power of a terminal + the comfort of an editor input."

Why build my own instead of using Warp / Cursor / Zed / Wave? Using someone else's tool means living with their decisions — send a PR and wait for release, or fork and maintain. Vibe coding makes the cost of building tools low; rather than route around friction every time, it's faster to build something that actually fits my workflow. There's also a personal motivation: this project doubles as a substantial piece on my resume.

## Who It's For

Shelf isn't aimed at a specific role (front-end / back-end / SRE all welcome) — it targets a **workflow profile**. If yours matches, Shelf fits; if not, it doesn't.

**Good fit**:
- **Multiple projects in parallel** — switching between working trees / environments throughout the day, not "finish one project then start the next"
- **CLI-first** — terminal is the main surface, IDE / Editor is the assistant
- **Heavy vibe coding** — Claude Code / Copilot CLI etc. running constantly
- **Cross-platform** — macOS / Windows (WSL) as daily drivers; SSH / Docker are part of normal work

**Not a fit**: people who want a large integrated environment (IDE-class). If you want file tree + LSP + debugger + refactor tools + graphical git client all in one window, VS Code / JetBrains is the right tool. Shelf is for "I already have my IDE / Editor — I just want the terminal layer to feel better."

## Typical Workflow

I typically have ~10 projects loaded but only the actively-worked ones connected. The rhythm is **constant project switching** — while one project's agent is thinking, jump to another and do something else, then come back when the agent finishes.

Where each surface fits in:

| Surface | Frequency | Use |
|---------|-----------|-----|
| Terminal | All the time | Main stage |
| Agent View | Always open (per connected project) | Vibing |
| Notes | As needed | Quick capture of gotchas / thoughts mid-work |
| PM Agent | Occasionally at home | Not suitable in work environments (corporate assets / security policy) |
| DevTools | Handy during debug | Base64 / JSON / URL / Hash — replaces external apps and online tools |

## Where Shelf Shines

1. **Fast project switching** — In tmux it was `cmd-b w` → scan list → find session → Enter. In Shelf it's one sidebar click, or `cmd+digit`. When you have 10 projects and switch constantly, switching cost matters a lot.

2. **Agent view beats raw CLI** — Mostly about input ergonomics (multi-line, editing, pasting long prompts) and a more comfortable surface. Feature parity with the CLI, but every day's worth of typing accumulates.

3. **SSH agents feel local** — Claude / Copilot over SSH behave the same as local because Shelf just forwards the PTY, with the agent running on the remote and output streamed back. Not specifically designed for this, but it ended up being one of Shelf's quiet wins (most other tools have a friction shift when you switch to SSH).

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
- **Init script** — per-project startup commands (e.g. `conda activate`, `source .venv/bin/activate`)
- **Default tabs** — per-project tab templates with individual commands, auto-opened on connect
- **Custom keybindings** — all shortcuts configurable via Settings panel
- **File paste / drag-drop** — drop or paste any file into the terminal; Shelf uploads it to `<projectCwd>/.tmp/shelf/` (works for local, SSH, WSL, Docker) and types the path
- **Background notifications** — system notification when long-running commands finish
- **Settings** — font, theme, scrollback, keybindings, log level, persisted to `settings.json`
- **Logging** — date-based log files, configurable level (off/error/info/debug), `LOG_LEVEL` env override
- **Auto-updater** — checks GitHub Releases, user confirms before downloading
- **PM Agent** — AI assistant that observes terminal tabs and can interact with CLI agents (Claude Code, Copilot, etc.). Supports Away Mode for autonomous operation, Telegram bridge for remote monitoring, and per-project notes

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

Shelf Terminal is a terminal wrapper — it does not install, configure, or authenticate any CLI tools. Any tools you want to use (conda, docker, claude, gh, etc.) must be set up independently. Shelf simply provides the terminal environment to run them in.

## Usage

### Init Script

Per-project commands that run automatically when the terminal connects. Set via right-click project → Edit.

Example: `conda activate myenv && export API_KEY=...`

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

### PM Agent

An AI assistant that observes all terminal tabs and helps manage CLI agents running in them.

**Setup**: Settings → PM Agent tab → choose a provider (OpenAI-compatible) and enter API key + model name.

**Features**:
- **Read-only by default** — scans terminal output, infers tab state (running, error, waiting for permission, done)
- **Away Mode** — enables `write_to_pty` so PM can send prompts, approve permissions, or interrupt stuck processes. Toggle via the PM panel header button or Telegram `/away`
- **Safety** — dangerous commands (`rm -rf /`, `git push --force`, etc.) are blocked by redline rules and escalated to the user
- **Notes** — per-project rolling summaries and a global note for cross-project context
- **Telegram bridge** — monitor and control terminals remotely (see below)

#### Telegram Bot Setup

1. Open Telegram, search for **@BotFather**, send `/newbot` and follow the prompts to get a **Bot Token**
2. Send any message to your new bot, then visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` — find `"chat":{"id":123456}` in the response, that number is your **Chat ID**
3. In Shelf: Settings → PM Agent → enter Bot Token and Chat ID
4. PM responses will be forwarded to Telegram. You can reply to PM with plain text, approve/deny escalations via inline buttons, or use slash commands:
   - `/help` — list commands
   - `/away` — toggle Away Mode
   - `/status` / `/tabs` — show project / tab states
   - `/stop` — cancel current PM generation

Shelf registers these commands with Telegram automatically, so typing `/` in chat shows autocomplete.

**Multi-device note**: if you run Shelf on more than one machine (home + work), create a separate bot for each. Telegram's long-polling API only allows one active poller per bot token, so sharing a token between machines causes messages to be routed randomly.

### Background Notification

When a command runs for more than 5 seconds and finishes while Shelf is not focused, a system notification appears. Only triggers after user keyboard input — background output from agent CLIs won't spam notifications.

## Quick Start

Requires **Node.js 22+**.

```bash
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

## Project Status

This is a public personal project. I don't actively market it, but if you find Shelf and your workflow lines up — or you just want to poke around — issues and PRs are welcome.

How it actually runs:
- ✅ Public repo, public releases, binaries published
- ✅ Issues read, reasonable PRs reviewed / merged
- ❌ No marketing / outreach / public roadmap commitments
- ❌ Won't add features that drift from the positioning just to grow the user base

## License

MIT
