# CLAUDE.md

## Agent Reference Docs

先讀 [.agent/index.md](.agent/index.md)（bundle 入口），或依情境直接跳：

| Situation | Read |
|-----------|------|
| 找功能在哪個檔案 | [.agent/map.md](.agent/map.md) |
| 理解系統結構 / 抽象資料流 | [.agent/architecture/index.md](.agent/architecture/index.md) |
| 查介面規格 / 訊息格式 / 路由規則 | [.agent/contracts/index.md](.agent/contracts/index.md) |
| 理解為什麼這樣設計、什麼不該改、debug 前先看 | [.agent/context/index.md](.agent/context/index.md) — decisions + gotchas 按 topic；code 以 `<topic>#N` 引用（如 `skills#4` → `context/skills.md` 第 4 條）|
| 評估新 feature 該不該做、判斷是否偏離產品定位 | [.agent/PRODUCT.md](.agent/PRODUCT.md) |
| 發版流程、tag 規範 | [.agent/RELEASE_FLOW.md](.agent/RELEASE_FLOW.md) |
| 開發中 feature 的暫存工作筆記 | [.agent/features/](.agent/features/) — **feature-dev-flow** skill 的 transient note（PRD/SDD/Spec/Tasks），收尾 consolidate 進永久 doc 後刪除；**非永久文件**（gitignored、不跨機器同步）|

### Documentation maintenance
開發新 feature 走 **feature-dev-flow** skill（transient note 累積 → 收尾才 consolidate 進永久 doc）；產生/重整整個 bundle 用 **project-agent-docs** skill；檔案格式信封見 **open-knowledge-format** skill（`index.md` 是 reserved file、無 frontmatter）。

零星改動則直接更新 `.agent/`：**新增/搬移模組** → `map.md`（intent → file + 一行 role）；**改資料流** → `architecture/<topic>.md`（抽象、不提檔名）；**介面/訊息變更** → `contracts/<topic>.md`；**新決策或 gotcha** → 對應 `context/<topic>.md`（append 下一個 `topic#N`，從 code 以 `<topic>#N` 引用）。context entry 寫**現況 + 為什麼**，不留 changelog / 已廢棄 feature / commit hash / 日期。

## Development

- Node.js 22+
- `npm run dev` — development (NODE_ENV=development, isolated userData)
- `npm run test:e2e` — E2E tests (NODE_ENV=test, isolated userData)。**耗時長（含 build，數分鐘）→ 用 Bash `run_in_background` 跑，不要前景阻塞等待**
- Production (packaged) uses default userData path

## Rules

- Bug fix 必須包含迴歸測試 — 先寫測試重現問題，再修 code
- **UI / 行為變更：E2E 是主動預設交付項，跟 unit test 同級** — 動到 renderer 行為（新元件、新流程、CRUD、互動）就在**同一步**補 E2E，不要標「deferred / 之後再寫」等被提醒。build 慢不是不做的理由：用 Bash `run_in_background` 跑 `npm run test:e2e -- <spec>`。core/非 UI 邏輯沒 surface 可 E2E 時才以 unit 為主。
- 不要啟動 dev server 或 Electron（`npm run dev` / `npx electron`）— AI 看不到畫面，只會干擾使用者。驗證用 `npm run typecheck` + `npm run test:unit`；需要驗 UI 行為就寫 E2E test
- 優先使用 `package.json` 定義的 npm scripts（如 `npm run typecheck`、`npm run test:unit`、`npm run test:e2e`），不要直接組底層指令（如 `tsc --noEmit`、`vitest run`）— 使用者開了 bypass permission，直接組指令會增加審閱負擔
- Commit 前確認 `.agent/` 是否需要更新（規範見上方「Documentation maintenance」）— 有新增功能、改變架構、或發現 gotcha 時一併更新
- `.agent/features/` 是暫時開發 context（gitignored、不跨機器同步）— **程式碼 / 測試 / 永久 doc 絕對禁止引用它**
- 優先思考、查證再動手，不要猜測 — 不確定的事先查 code / 文件 / 既有實作確認（例：裝套件前先 `npm view <pkg> versions` 確認版本，不要假設版號）
- 設計盡可能簡單，避免過度設計 / 過度抽象 / 過度設定 — 先滿足當前需求，不預先為想像中的未來鋪設
- 修正問題時只動必要的項目 — 不順手改無關的 code / 格式 / 重構，降低審閱與回歸風險
- 有錯就停，逐一修復再測，不要重複跑整套 build/test
- 需要 dev 整個重 build 才能驗的項目（如 agent-server bundle 改動），先把所有相關項目一口氣做完再交給 dev 驗一輪 — 不要做一個交一個，造成來回重 build 浪費時間
- 同一個問題一次無法修正，請嘗試使用 logger 靠實際輸出定位，不要純粹依靠讀 code（renderer 端走 `debugLog` bridge 落 main log 檔，AI 可直接讀）
- 禁止靜默吞錯 / 丟資料 — 狀態對不上、解析失敗、收到非預期輸入時要 fail-loud（log 出關鍵 id / context），不要 silent `return` 或 catch 後不處理。良性 race 用低調 log（`debugLog` 落檔）、真資料遺失要大聲（`console.warn/error`）；純函式回傳 anomaly 讓 caller log（保持可測）。樂觀更新尤其要在跟真相源對帳對不上時留痕

## Conventions

- **Renderer 三機制職責**（先想清楚一個動作屬於哪個）：
  - **Store（中心化 state 服務，zustand 式）** = 所有 renderer-local state 的讀與改；mutation 走 store 具名 action（同步呼叫，需要時可回傳值，如 `peekAgentTab` 讀、`enqueuePendingSend` 寫）。state 的事就 store 管。
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
- **跨檔 / 重複使用的字串值用具名 const，不散落 magic string** — type 標籤、wire kind、事件名、IPC channel、固定路徑片段之類，在單一 source-of-truth 用 `const` / `as const` 物件定義一次，call site(設值端 + 判斷/消費端)一律引用常數,不直接寫字面值。型別盡量從常數 derive（`keyof typeof` / `typeof X`），新增值＝加一筆常數，不用同時改 union 與各處 case。既有範例：`IPC`（`ipc-channels.ts`）、`ShelfFileTypeMcp`/`SHELF_PLACEMENTS`（`shared/shelf-paths.ts`）。一次性、單檔內的字串不必硬抽。
