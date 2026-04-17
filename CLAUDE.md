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
- 不要啟動 dev server 或 Electron（`npm run dev` / `npx electron`）— AI 看不到畫面，只會干擾使用者。驗證用 `tsc --noEmit` + `vitest run`；需要驗 UI 行為就寫 E2E test
- Commit 前確認 `.agent/` 文件是否需要更新（PROJECT_MAP, DECISIONS, GOTCHAS）— 有新增功能、改變架構、或發現 gotcha 時一併更新
- 安裝套件前先 `npm view <pkg> versions` 確認最新穩定版，不要假設版本號
- 有錯就停，逐一修復再測，不要重複跑整套 build/test

## Conventions

- All user actions go through event bus (`src/renderer/events.ts`)
- Trigger sites (UI components, keybindings) only `emit()` events
- Side effects (pty kill, terminal dispose, persist) handled centrally in `App.tsx`
- Connection-specific logic abstracted via `createConnector()` factory in `src/main/connector/`; preload is RPC bridge only
- Keybindings are configurable via Settings; parameterized actions use `action_param` pattern (e.g. `switchTab_3`)
- App keybindings intercept at capture phase with `stopPropagation`; xterm never receives matched combos
