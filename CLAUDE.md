# CLAUDE.md

## Agent Reference Docs

| Situation | Read |
|-----------|------|
| 找功能在哪個檔案 | [.agent/PROJECT_MAP.md](.agent/PROJECT_MAP.md) |
| 理解為什麼這樣設計、什麼不該改 | [.agent/DECISIONS.md](.agent/DECISIONS.md) |
| 遇到奇怪行為、debug 前先看 | [.agent/GOTCHAS.md](.agent/GOTCHAS.md) |

## Release Flow

- Push tag `v*` triggers GitHub Actions build for macOS / Windows / Linux
- GitHub Actions creates a **draft release** with `generate_release_notes`
- Version bump commit message should serve as release notes, listing changes:

```
v0.x.x

- Feature/fix description
- Feature/fix description
```

- After build completes, review the draft release on GitHub and publish

## Development

- Node.js 22+ via nvm (`nvm use 22.22`)
- `npm run dev` — development (NODE_ENV=development, isolated userData)
- `npm run test:e2e` — E2E tests (NODE_ENV=test, isolated userData)
- Production (packaged) uses default userData path

## Conventions

- All user actions go through event bus (`src/renderer/events.ts`)
- Trigger sites (UI components, keybindings) only `emit()` events
- Side effects (pty kill, terminal dispose, persist) handled centrally in `App.tsx`
- Connection-specific logic (local/SSH/WSL) abstracted behind `connector` API in preload
- Keybindings are configurable via Settings; parameterized actions use `action_param` pattern (e.g. `switchTab_3`)
