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
- 不要啟動 dev server 或 Electron（`npm run dev` / `npx electron`）— AI 看不到畫面，只會干擾使用者。驗證用 `npm run typecheck` + `npm run test:unit`；需要驗 UI 行為就寫 E2E test
- 優先使用 `package.json` 定義的 npm scripts（如 `npm run typecheck`、`npm run test:unit`、`npm run test:e2e`），不要直接組底層指令（如 `tsc --noEmit`、`vitest run`）— 使用者開了 bypass permission，直接組指令會增加審閱負擔
- Commit 前確認 `.agent/` 文件是否需要更新（PROJECT_MAP, DECISIONS, GOTCHAS）— 有新增功能、改變架構、或發現 gotcha 時一併更新
- 安裝套件前先 `npm view <pkg> versions` 確認最新穩定版，不要假設版本號
- 有錯就停，逐一修復再測，不要重複跑整套 build/test

## Conventions

- 所有 user action 走 event bus (`src/renderer/events.ts`)
- 觸發點 (UI 元件、keybindings) 只 `emit()` event，不執行 side effect
- Side effect (pty kill、terminal dispose、persist) 集中在 `App.tsx` 處理
- Sibling 元件間接相依：動作走 EventBus、共享 state 走 Store；不靠共同父層 state coordinator（避免父層 cascade re-render）
- Connection-specific 邏輯走 `createConnector()` factory (`src/main/connector/`)；preload 純 RPC bridge 不含 dispatch
- Agent backend (provider/SDK 細節) 完全封裝在 `agent-server/`；renderer 不感知 provider type、tool name、slash 語法
- Wire payload 給 renderer 是渲染原語 (reply / fold_code / fold_markdown / fold_diff / note / system / error)，不是 provider 語意 (thinking / tool_use / slash_response)
- Config source-of-truth 單向流動：renderer 持有 prefs → backend imperative apply 不 cache；backend 持有 status / capabilities → renderer 純展示
- 有參數的 keybinding action 用 `action_param` pattern (例: `switchTab_3`)
