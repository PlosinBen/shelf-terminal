---
type: context
title: Settings & Config
related:
  - contracts/persistence-formats
  - context/keybindings-shell
  - context/storage
---

# Settings & Config

> userData 隔離、settings/keybindings merge、開窗前 bootstrap 載 config，以及 DEFAULT_SETTINGS 該放哪。

## settings-config#1 — userData 隔離靠 Electron 內建訊號  ·  [Decision]

**Decision**：`src/main/user-data-path.ts` 的 `applyUserDataIsolation()` 在 `index.ts` top-level 呼叫一次（idempotent guard）。判斷邏輯：
- `app.isPackaged === true` → packaged 安裝版 → 保留 OS-default 路徑（prod）
- `app.commandLine.hasSwitch('user-data-dir')` → E2E tempdir 自己指定 → 不動
- 其他（dev、`npx electron .`、`npm run pack`）→ OS-default 路徑加 `-dev` 後綴

E2E 測試在 `e2e/helpers.ts` 每個 worker `mkdtempSync` 一個 tempdir，啟動帶 `--user-data-dir=<tempdir>`，結束 `rm -rf`。**NODE_ENV 不參與 userData 決策**。

**Reason**：舊版靠 `NODE_ENV` 當 gate，本地 `npx electron .` / `npm run pack` 沒帶就寫進正式 userData（`projects.json` 遺失事件）。`app.isPackaged` 是 Electron 原生訊號，packaged runtime 直接讀，不需要 build-time inline。Safe-by-default：任何 unpackaged 啟動都自動掛 `-dev`。

**Do not change because**：
- 把 gate 換回 `NODE_ENV` → 回到舊版 bug。
- 把 fallback 拿掉變成「isPackaged 以外都寫 OS-default」→ safe-by-default 失效。
- 把 `applyUserDataIsolation()` 搬進 `whenReady` → 晚於 Electron 內部初始化（Cookies、Cache），部分資料寫錯路徑。
- E2E 改回 `NODE_ENV=test` 推算路徑 → worker 無法併行、會刪到 dev userData。

**Related**：`src/main/user-data-path.ts`、`src/main/index.ts`、`e2e/helpers.ts`。

## settings-config#2 — Settings Shallow Merge with Defaults + Deep Merge Keybindings  ·  [Decision]

**Decision**：`loadSettings()` 用 `{ ...DEFAULT_SETTINGS, ...saved }` merge，新增 setting key 時舊的 settings.json 自動補預設值。`keybindings` 額外做 deep merge（`{ ...DEFAULT_KEYBINDINGS, ...saved.keybindings }`），確保新增的快捷鍵不會被舊設定覆蓋掉。

**Reason**：向前相容。用戶升級版本後不需要手動加新欄位。keybindings 是巢狀物件，shallow merge 會讓舊存檔整個覆蓋 defaults，導致新快捷鍵消失。

**Do not change because**：如果直接讀 saved 不 merge，舊版 settings.json 缺少新欄位會 crash。如果 keybindings 不 deep merge，每次新增快捷鍵都要手動刪 settings.json 才能生效。

## settings-config#3 — Bootstrap 在開窗前先載入 config，失敗時 blocking dialog  ·  [Decision]

**Decision**：`app.whenReady()` 裡先呼叫 `bootstrap()` 同步載入 `projects.json` 和 `settings.json`，再 `createWindow()`。`loadProjects` / `loadSettings` 回傳 `LoadResult` discriminated union（`ok | parse | permission | read`），bootstrap 根據錯誤型別跳對應的 `dialog.showMessageBoxSync`：parse 給「Quit / Backup & Continue」、permission/read 只給 Quit。

**Reason**：
- 過去 config 損毀時 silent 退回 default，使用者不會意識到自己的 project 列表「不見了」直到下次儲存覆寫。
- Sync dialog 在 ready 階段是少數能 block 的時機；window 都還沒開，視覺上不會看到半成品的 UI 又跳錯。
- E2E 測試用 `SHELF_BOOTSTRAP_DIALOG_RESPONSE=quit|continue` env 變數 mock dialog 回應，避免測試卡在 native 對話框。

**Do not change because**：把 dialog 推到 createWindow 之後 / 用 async dialog 會讓 race condition 變多（renderer 已經跟 main 要 cachedProjects 但 cache 還沒填）。

## settings-config#4 — DEFAULT_SETTINGS 不能放在 types.ts  ·  [Gotcha]

**Symptom**：Renderer 啟動時報 `settings is not defined`，白屏。

**Root cause**：`types.ts` 通常只有 type export，vite 在 production build 時可能對 runtime value export 處理不一致。`DEFAULT_SETTINGS` 放在 `types.ts` 裡，store.ts import 它時在 bundle 中變成 undefined。

**Fix**：Runtime value 獨立放在 `shared/defaults.ts`，type 留在 `types.ts`。

**注意**：搬 runtime value 出 `types.ts` 後，vite build cache 可能因「內容沒變、只是 import source 不同」而不重建，問題依舊 → `rm -rf dist` 強制清除再 build。
