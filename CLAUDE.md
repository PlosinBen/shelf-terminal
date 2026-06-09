# CLAUDE.md

## Agent Reference Docs

| Situation | Read |
|-----------|------|
| 評估新 feature 該不該做、判斷是否偏離產品定位 | [.agent/PRODUCT.md](.agent/PRODUCT.md) |
| 找功能在哪個檔案 | [.agent/PROJECT_MAP.md](.agent/PROJECT_MAP.md) |
| 理解為什麼這樣設計、什麼不該改（按領域分檔，編號全域唯一）| [.agent/DECISIONS-core.md](.agent/DECISIONS-core.md) (基礎建設) ・ [.agent/DECISIONS-pm.md](.agent/DECISIONS-pm.md) (PM agent) ・ [.agent/DECISIONS-agent.md](.agent/DECISIONS-agent.md) (Agent provider) |
| 遇到奇怪行為、debug 前先看 | [.agent/GOTCHAS.md](.agent/GOTCHAS.md) |
| 發版流程、tag 規範 | [.agent/RELEASE_FLOW.md](.agent/RELEASE_FLOW.md) |
| 開發某個 feature 時的暫存 context（規劃、spike 記錄、待辦）| [.agent/features/](.agent/features/) — 純開發過程的工作筆記，feature 做完即丟，**非永久文件**（gitignored、不跨機器同步）|

## Development

- Node.js 22+
- `npm run dev` — development (NODE_ENV=development, isolated userData)
- `npm run test:e2e` — E2E tests (NODE_ENV=test, isolated userData)。**耗時長（含 build，數分鐘）→ 用 Bash `run_in_background` 跑，不要前景阻塞等待**
- Production (packaged) uses default userData path

## Rules

- Bug fix 必須包含迴歸測試 — 先寫測試重現問題，再修 code
- 不要啟動 dev server 或 Electron（`npm run dev` / `npx electron`）— AI 看不到畫面，只會干擾使用者。驗證用 `npm run typecheck` + `npm run test:unit`；需要驗 UI 行為就寫 E2E test
- 優先使用 `package.json` 定義的 npm scripts（如 `npm run typecheck`、`npm run test:unit`、`npm run test:e2e`），不要直接組底層指令（如 `tsc --noEmit`、`vitest run`）— 使用者開了 bypass permission，直接組指令會增加審閱負擔
- Commit 前確認 `.agent/` 文件是否需要更新（PROJECT_MAP, DECISIONS, GOTCHAS）— 有新增功能、改變架構、或發現 gotcha 時一併更新（GOTCHAS 條目的寫法規範見該檔開頭）
- `.agent/features/` 是暫時開發 context（gitignored、不跨機器同步）— **程式碼 / 測試 / 永久 doc 絕對禁止引用它**
- 優先思考、查證再動手，不要猜測 — 不確定的事先查 code / 文件 / 既有實作確認（例：裝套件前先 `npm view <pkg> versions` 確認版本，不要假設版號）
- 設計盡可能簡單，避免過度設計 / 過度抽象 / 過度設定 — 先滿足當前需求，不預先為想像中的未來鋪設
- 修正問題時只動必要的項目 — 不順手改無關的 code / 格式 / 重構，降低審閱與回歸風險
- 有錯就停，逐一修復再測，不要重複跑整套 build/test

## Conventions

- **Renderer 三機制職責**（先想清楚一個動作屬於哪個）：
  - **Store（中心化 state 服務，zustand 式）** = 所有 renderer-local state 的讀與改；mutation 走 store 具名 action（同步、可回傳值，如 `dequeueMessage`）。state 的事就 store 管。
  - **Event bus (`src/renderer/events.ts`)** = 跨 component 的事件/意圖傳遞（解耦 pub/sub：component → 別的 component 或中央 handler），含「我 `emit` → 中央 handler 執行（常打 IPC）」這種跨界意圖。
  - **IPC (`window.shelfApi.*`)** = 跨 process 到 main 的唯一通道（preload 純 RPC bridge）。
  - 判別：碰 main → IPC；動 renderer state → store action；跨 component 傳事件/意圖 → bus。**read-return（同步要回傳值）用函式呼叫，別拆成 request/response event**（會把原子同步呼叫劈成非同步 + correlation，在 bus 上重造函式回傳）。
- 觸發點 (UI 元件、keybindings) 只 `emit()` event，不執行 side effect；會打 main / 跨子系統的 side effect (pty kill、terminal dispose、persist) 集中在 `App.tsx`
- 動作別繞共同父層 state coordinator：child 直接 emit bus event，不用 prop callback 往上轉手（避免父層 cascade re-render）
- Connection-specific 邏輯走 `createConnector()` factory (`src/main/connector/`)；preload 純 RPC bridge 不含 dispatch
- Agent backend (provider/SDK 細節) 完全封裝在 `agent-server/`；renderer 不感知 provider type、tool name、slash 語法
- Wire payload 給 renderer 是渲染原語 (reply / fold_code / fold_markdown / fold_diff / note / system / error)，不是 provider 語意 (thinking / tool_use / slash_response)
- Config source-of-truth 單向流動：renderer 持有 prefs → backend imperative apply 不 cache；backend 持有 status / capabilities → renderer 純展示
- 有參數的 keybinding action 用 `action_param` pattern (例: `switchTab_3`)
