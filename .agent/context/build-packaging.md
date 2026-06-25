---
type: context
title: Build & Packaging
related:
  - context/pm-agent
  - context/deployment
---

# Build & Packaging

> electron-builder CI / 打包、npm 環境、code signing、E2E build 的踩雷集。

## build-packaging#1 — electron-builder CI 需要 top-level permissions  ·  [Gotcha]

**Symptom**：GitHub Actions build 報 `403 Forbidden`。

**Root cause**：electron-builder 在 build 時自動嘗試 publish 到 GitHub Release，需要 `contents: write` 權限。如果權限只在 release job 而非 build job，會被拒絕。

**Fix**：workflow 頂層設 `permissions: contents: write`，讓 electron-builder 直接 publish。

## build-packaging#2 — Linux deb 打包需要 author email  ·  [Gotcha]

**Symptom**：CI Linux build 報 `Please specify author 'email'`。

**Root cause**：electron-builder 打 `.deb` 時需要 maintainer email，從 `package.json` 的 `author` 欄位讀取。

**Fix**：`package.json` 的 `author` 必須包含 email：`"PlosinBen <plosinben@gmail.com>"`。

## build-packaging#3 — npm sudo 污染 ~/.npm 導致後續 install EACCES  ·  [Gotcha]

**Symptom**：`npm install vitest` 報 `EACCES: permission denied` 寫 `~/.npm/_cacache`，但專案本身的 node_modules 是使用者擁有的。

**Root cause**：過去用過 `sudo npm install -g <pkg>` → npm 在 `~/.npm/_cacache` / `~/.npm/_logs` 留下 root-owned 檔，之後非 sudo 的 npm 寫不進去。

**Fix**：
1. 確認 global prefix 是使用者可寫的路徑（`npm root -g` 不應指向 `/usr/local/lib/node_modules` 等系統目錄）。具體怎麼設定是使用者自己的環境問題（版本管理工具、手動設 prefix、或其他）。
2. 把曾經 sudo 裝過的 global package 重新非 sudo 安裝：先 `sudo npm uninstall -g <pkg...>`、再 `sudo rm -rf ~/.npm/_cacache`、最後 `npm install -g <pkg...>`。
3. AI CLI tool 的 session（Claude Code、Copilot、Gemini 等）放在 `~/.copilot/` / `~/.claude/` / `~/.gemini/` 等獨立目錄，npm uninstall 不會碰。

**Rule**：即使是全域 CLI 工具也用 `npm install -g`，**永遠不要 `sudo npm`**。

## build-packaging#4 — macOS 自動更新需要 code signing  ·  [Gotcha]

**Symptom**：macOS 上 electron-updater 檢查到新版但無法安裝更新。

**Root cause**：CI build 設了 `CSC_IDENTITY_AUTO_DISCOVERY: false`、出來的 macOS binary 沒簽名；Squirrel.Mac 要求更新包必須經 code signing。Windows 不受影響。

**Status**：沒 Apple Developer cert（年費 $99），macOS 用戶手動下載新版。要啟用時把 cert 經 `CSC_LINK` + `CSC_KEY_PASSWORD` 帶進 CI、移除 `CSC_IDENTITY_AUTO_DISCOVERY: false`、補 notarization。

## build-packaging#5 — E2E 測試需要先 build（npm run build）  ·  [Gotcha]

**Symptom**：E2E 測試找不到 PM 相關的 DOM 元素。

**Root cause**：E2E 透過 Playwright 啟動 Electron，載入的是 `dist/` 的 static build，不是 vite dev server。如果 `dist/` 裡是舊 build，看不到新加的 UI。

**Fix**：跑 E2E 前一律先 `NODE_ENV=test npm run build`。`npm run test:e2e` script 已經包含 build 步驟。

## build-packaging#6 — agent-server bundle 的 esbuild `target: node20`，遇舊/缺 remote node 會 SyntaxError  ·  [Gotcha]

**Symptom**：agent-server bundle 在某些遠端機器跑出 cryptic `SyntaxError`。

**Root cause**：agent-server 用 esbuild 以 `target: node20` 打包，產物含 node20 才支援的語法。遠端若裝舊版 node（或沒裝），執行即 SyntaxError。

**Fix**：**自帶 pinned Node**、不依賴遠端的 node —— `NODE_VERSION`（`agent-runtime-versions.ts`）對齊 esbuild `target: node20`，部署時把 Node 一起送（見 `deployment#1`/`deployment#2`）。Node builder 為 **glibc-only**（不出 musl Node，musl target 直接 throw）；Claude companion binary 另有官方 `-musl` 版。
