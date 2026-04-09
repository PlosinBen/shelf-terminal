# CLAUDE.md

## Agent Reference Docs

| Situation | Read |
|-----------|------|
| 找功能在哪個檔案 | [.agent/PROJECT_MAP.md](.agent/PROJECT_MAP.md) |
| 理解為什麼這樣設計、什麼不該改 | [.agent/DECISIONS.md](.agent/DECISIONS.md) |
| 遇到奇怪行為、debug 前先看 | [.agent/GOTCHAS.md](.agent/GOTCHAS.md) |
| 發版流程、tag 規範 | [.agent/RELEASE_FLOW.md](.agent/RELEASE_FLOW.md) |

## Development

- Node.js 22+
- `npm run dev` — development (NODE_ENV=development, isolated userData)
- `npm run test:e2e` — E2E tests (NODE_ENV=test, isolated userData)
- Production (packaged) uses default userData path

## Rules

- Bug fix 必須包含迴歸測試 — 先寫測試重現問題，再修 code
- Connector 相關問題先在 local 用 log 驗證，不依賴特定平台測試
- Release notes 從 `git log <last-tag>..HEAD` 取得，不靠記憶

## Conventions

- All user actions go through event bus (`src/renderer/events.ts`)
- Trigger sites (UI components, keybindings) only `emit()` events
- Side effects (pty kill, terminal dispose, persist) handled centrally in `App.tsx`
- Connection-specific logic (local/SSH/WSL) abstracted behind `connector` API in preload
- Keybindings are configurable via Settings; parameterized actions use `action_param` pattern (e.g. `switchTab_3`)
