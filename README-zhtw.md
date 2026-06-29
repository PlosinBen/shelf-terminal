# Shelf Terminal

> English: [README.md](./README.md)

跨平台、以 project 為單位的 terminal 管理工具，用 Electron 打造。替代 tmux 處理多專案 CLI 工作流。

## Shelf 是什麼

Shelf 是一個 project-based 的 terminal 管理工具 — 讓你同時開 10+ 個 terminal、橫跨多個專案，卻不用花心力整理 window / session。它是 tmux + session 管理 plugin 的精神接班人，目標是比那條路順手。Agent view（Claude Code / Copilot CLI 等）是附加功能，不是核心賣點。

## 為什麼做這個

以前長期重度使用 tmux，但隨著手上專案數量變多，window / session 管理變得很困擾 — 視窗狀態要靠 plugin 才能存，找東西還是很麻煩。日常工作平均開著 10+ 個 terminal — 自從 vibing CLI 工具（Claude Code、Copilot CLI）進入我的工作流，數量只多不少。這個負擔變成每天都在繳的稅。

工作流也在這段時間悄悄轉變。原本是 terminal + JetBrains IDE 雙主場，vibing 之後逐漸把重心移到 CLI，IDE 退居二線、只剩看 code 的功能。重心一旦從 IDE 搬到 terminal，terminal 本身的順手程度就變成關鍵痛點 — 它不再是輔助工具，而是主舞台。

Agent view 是另一個獨立的起點。CLI agent（Claude Code、Copilot CLI 之類）本身夠強，但 input area 的體驗很弱 — 多行輸入、回頭修改、貼長段 prompt 都跟一般使用者的習慣不一樣，每次都要重新適應。我想要一個「terminal 該有的力量 + 編輯器該有的順手 input」的混合體。

為什麼自己做而不是用 Warp / Cursor / Zed / Wave？用別人的東西就是要遷就 — 不順手就只能發 PR 等 release，或自己 fork 維護。現在 vibe coding 成本很低，與其每次踩到不順手都繞路，不如自己做一個真正貼合自己工作流的工具。私心上也希望這個專案能成為履歷上有料的一筆。

## 適合誰用

Shelf 不是針對某個角色設計（前端 / 後端 / SRE 都可能），而是針對某種 **工作流習慣**。對得上就適合，對不上就不適合。

**適合的工作流**：

- **多專案並行**：同時手上掛著多個 project，需要快速切換 working tree / 環境，而不是一次只開一個專案做完再開下一個
- **CLI 為主**：日常重心在 terminal，IDE / Editor 是輔助；習慣用 CLI 完成大部分工作
- **大量 vibing coding**：常駐使用 Claude Code / Copilot CLI 等 agent 工具寫 code
- **跨平台**：macOS / Windows (WSL) 雙主場，遠端 (SSH / Docker) 也是日常戰場

**明確不適合**：需要大型整合環境（IDE-class）的人。如果你想要的是 file tree、LSP、debugger、refactor 工具、graphical git client 通通在同一個視窗，那 VSCode / JetBrains 才是對的工具 — Shelf 適合的是「IDE / Editor 已經有了，但 terminal 那層想要更順手」的人。

## 典型工作流

我手邊大概有 10 個 project 同時掛著，但不會全部 connected — 只有真正在處理中的那幾個會連線。實際工作節奏是「**幾乎一直在切專案**」：通常是某個 project 的 agent 還在思考時，就快速切到另一個 project 繼續做事，agent 跑完再切回來看結果。

各區塊的實際使用頻率：

| 區塊 | 頻率 | 用途 |
|------|------|------|
| Terminal | 全時間 | 主舞台 |
| Agent View | 常駐（connected 專案都開著） | vibing |
| Notes | 需要時 | 過程踩雷 / 想法順手記下來 |
| PM Agent | 家裡偶爾 | 公司環境不合適（涉及公司非個人資產、可能違反 security policy） |
| DevTools | debug 時順手 | Base64 / JSON / URL / Hash 等開發小工具，以前要另外裝 app 或開線上版，內建之後 debug 時直接 ⌘D 就能用 |

## Shelf 比較有感的時刻

1. **快速切 project** — tmux 時代的流程是 `cmd-b w` → 看清單 → 找到要的 session → Enter。在 Shelf 變成滑鼠點一下 sidebar，或 `cmd+數字` 直接跳。switching cost 在「同時 10 個 project + 一直切」的情境下差很多。

2. **Agent view 比 CLI 順** — 主要差在 input area 體驗（多行、編輯、貼長 prompt 不卡），畫面也比裸 CLI 舒服。功能面跟 CLI 等價，但每天打字幾百次，順手感累積差很多。

3. **SSH 上跑 agent 沒感覺**（這是好事）— Claude / Copilot 在 SSH 上跑跟 local 體感一致，因為 Shelf 底層只是 PTY 轉發，agent 本身在遠端跑、輸出原樣回傳。沒有刻意做、但確實是 Shelf 的價值之一（其他工具切 SSH 通常會有割裂感）。

## 功能列表

- **Project-based** — 每個 project 綁定一個資料夾，可開多個 terminal tab
- **Lazy connect** — project 載入時不自動連線；點擊或按 Enter 才開 terminal
- **Terminal tabs** — per-project tab，底層是真實 pty process（node-pty + xterm.js）
- **Agent tabs** — 在獨立分頁跑 Claude Code / Copilot CLI，搭配 editor 級輸入（多行編輯、回頭修改、貼長 prompt）；SSH 上行為一致
- **Web tabs** — 在分頁裡開網頁，跟 terminal 並列
- **Split pane** — project 內可左右分割（mod+\\）
- **SSH / WSL** — 透過 SSH 連遠端（ControlMaster multiplex、密碼驗證）或 WSL（distro 下拉選單）
- **主題** — 5 個內建主題（Catppuccin Mocha/Latte、Dracula、Nord、Tokyo Night）
- **Terminal 搜尋** — 搜尋 scrollback buffer（mod+F）
- **Tab 管理** — 雙擊重命名、拖拉排序、mod+1~9 切換
- **Tab badge** — 背景 tab 有新輸出時顯示未讀指示
- **Project 管理** — 拖拉排序、右鍵選單（Edit、Connect/Disconnect、Close）
- **Init script** — 每個 project 啟動指令（例如 `conda activate`、`source .venv/bin/activate`）
- **預設 tabs** — 每個 project 可定義啟動時自動開的 tab，各自有啟動指令
- **自訂快捷鍵** — 所有快捷鍵都可在 Settings 修改
- **檔案 paste / drag-drop** — 拖放或貼上任何檔案到 terminal；Shelf 上傳到 `<projectCwd>/.tmp/shelf/` 並輸入路徑（支援 local、SSH、WSL、Docker）
- **背景通知** — 長時間指令在 Shelf 失焦時跑完，跳系統通知
- **Settings** — 字型、主題、scrollback、快捷鍵、log level，持久化到 `settings.json`
- **Logging** — 日期分檔的 log，可設定 level（off/error/info/debug），可用 `LOG_LEVEL` env 覆寫
- **自動更新** — 檢查 GitHub Releases，使用者確認後下載
- **Skills** — app-level skills 供 agent 使用，可在 app 內編輯，並投射給 local 與 remote（SSH）agent
- **PM Agent** — AI 助手，觀察 terminal tab 並可操作 CLI agent（Claude Code、Copilot 等）。支援 Away Mode 自主操作、Telegram bridge 遠端監控、per-project notes

## 技術 Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 41 |
| Terminal | node-pty 1.1 + @xterm/xterm 6.0 |
| UI | React 19 + TypeScript 5.9 |
| Build | Vite 6.4 + vite-plugin-electron |
| Package | electron-builder |
| Test | Playwright (Electron) |

## 注意事項

Shelf Terminal 是一個 terminal wrapper — 它不會幫你安裝、設定、或登入任何 CLI 工具。你想用的工具（conda、docker、claude、gh 等）都必須自己另外設定好。Shelf 只負責提供 terminal 環境讓你跑這些工具。

## 使用方式

### Init Script

每個 project 在 terminal 連線時自動執行的指令。在 project 右鍵 → Edit 設定。

範例：`conda activate myenv && export API_KEY=...`

對於「每次開 terminal 都要打的環境設定」很實用。

### Default Tabs

預先定義 project 連線後自動打開的 tab，每個 tab 有自己的指令。在 project 右鍵 → Edit 設定。

範例：一個 `dev` tab 跑 `npm run dev`、一個 `test` tab 跑 `npm run test:watch`、一個普通 `shell` tab 不帶指令。

### SSH 共用連線

到同一個 SSH host 的多個 tab 共用一個 TCP 連線（ControlMaster）。開 5 個 tab — 只需驗證一次。

### 檔案 Paste & Drag-Drop

貼上或拖放任何檔案（image、PDF、archive、log 等）到 terminal。Shelf 上傳到 `<projectCwd>/.tmp/shelf/<prefix>-<filename>` 並把 shell-quoted 路徑輸入到 terminal。

- 支援 **local、SSH、Docker、WSL** project 統一路徑。SSH / Docker / WSL 透過 `sh -c "cat > …"` 串流（不依賴 scp / docker-cp）
- 目標路徑在 project 目錄內，受 sandboxed agent CLI（Claude Code、Gemini、Codex 等）權限限制的工具也讀得到
- 多檔拖放並行上傳，產生的路徑會在同一行以空白分隔插入
- 超過 Settings 中 **Max Upload Size (MB)**（預設 50）的檔案會跳過並彈窗通知，其餘正常上傳
- 第一次上傳時會自動建 `.tmp/.gitignore`（內容 `*`），避免污染 git
- **自動清理**：project 第一個 tab 開啟後幾秒，會在背景刪除前次 Shelf session 留下的 upload 檔。當下 session 建立的檔案不會被動到（cutoff 從檔名的 timestamp prefix 解出來）。可在 **Edit Project → Clear uploaded files** 手動清理 — remote 未連線時按鈕會 disabled 並顯示提示

### PM Agent

一個 AI 助手，觀察所有 terminal tab 並協助管理在裡面跑的 CLI agent。

**設定**：Settings → PM Agent tab → 選 provider（OpenAI-compatible），輸入 API key + model name。

**功能**：
- **預設唯讀** — 掃描 terminal 輸出，推斷 tab state（running、error、等待 permission、done）
- **Away Mode** — 啟用 `write_to_pty`，讓 PM 可送 prompt、批准 permission、中斷卡住的 process。可從 PM panel header button 或 Telegram `/away` 切換
- **安全機制** — 危險指令（`rm -rf /`、`git push --force` 等）會被 redline rule 擋下並升級給使用者確認
- **Notes** — per-project 滾動摘要 + 跨專案 global note
- **Telegram bridge** — 遠端監控 / 操作 terminal（見下方）

#### Telegram Bot 設定

1. 開啟 Telegram，搜尋 **@BotFather**，發送 `/newbot` 並照提示拿到 **Bot Token**
2. 對你的新 bot 發任何訊息，然後開 `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` — 找到 `"chat":{"id":123456}`，那個數字就是 **Chat ID**
3. Shelf 裡：Settings → PM Agent → 填入 Bot Token 跟 Chat ID
4. PM 回應會 forward 到 Telegram。可以用純文字回覆 PM、透過 inline button 批准 / 拒絕 escalation，或用 slash command：
   - `/help` — 列出指令
   - `/away` — 切換 Away Mode
   - `/status` / `/tabs` — 顯示 project / tab 狀態
   - `/stop` — 取消當前 PM 生成

Shelf 會自動向 Telegram 註冊這些 command，所以在 chat 裡輸入 `/` 會出現自動完成。

**多裝置注意**：如果你在多台機器跑 Shelf（家裡 + 公司），請各自建獨立 bot。Telegram long-polling API 同一個 token 同時只能有一個 active poller，共用 token 會讓訊息隨機派發。

### 背景通知

當指令跑超過 5 秒、結束時 Shelf 處於非 focus 狀態，系統會跳通知。只有在使用者鍵盤輸入過之後才會觸發 — 純 agent CLI 背景輸出不會 spam 通知。

## Quick Start

需要 **Node.js 22+**。

```bash
# 安裝相依（包含 electron-rebuild for node-pty）
npm install

# 開發模式
npm run dev

# Production build
npm run build

# 打包
npm run dist:mac    # macOS (.dmg, .zip)
npm run dist:win    # Windows (.exe, .zip)
npm run dist:linux  # Linux (.AppImage, .deb)
```

## 快捷鍵

`mod` = Cmd (macOS) / Ctrl (Windows/Linux)。所有快捷鍵都可在 Settings 修改。

| 動作 | 預設 |
|--------|---------|
| 切換 sidebar | `mod+B` |
| 新 project | `mod+O` |
| 關閉 project | `mod+W` |
| 新 tab | `mod+T` |
| 切換 tab | `mod+1~9` |
| 上一個 / 下一個 tab | `mod+Shift+[/]` |
| 切換 project | `mod+Up/Down` |
| 切換 split pane | `mod+\` |
| 搜尋 | `mod+F` |
| Settings | `mod+,` |

## 專案結構

```
src/
  main/           # Electron main process、pty 管理、IPC handler
  renderer/       # React UI、xterm.js、store、theme、event bus
  shared/         # Type 定義、IPC channel、defaults
e2e/              # Playwright E2E 測試
```

## 測試

```bash
# 跑所有 E2E 測試（會先 build）
npm run test:e2e
```

## macOS — 未簽名 App

App 沒有 code-signing。首次啟動 macOS 會擋下來，要開啟的話：

1. 對 `Shelf.app` 右鍵 → Open（或 System Settings → Privacy & Security → Open Anyway）
2. 或執行：`xattr -cr /Applications/Shelf.app`

## Settings

儲存在 `~/Library/Application Support/shelf-terminal/settings.json`（macOS）或 `~/.config/shelf-terminal/`（Linux / Windows）。

Projects 存在同一個位置的 `projects.json`。

Dev / test 環境使用獨立路徑（`shelf-terminal-development`、`shelf-terminal-test`）。

## Project Status

這是一個公開的個人專案。不會主動推廣或 marketing，但如果你發現了 Shelf、覺得工作流對得上 — 或單純想看看 — 歡迎丟 issue 跟 PR。

實際運作方式：
- ✅ Repo 公開、release 公開、釋出 binary
- ✅ Issue 會看、合理的 PR 會 review / merge
- ❌ 不做 marketing / outreach / roadmap 公開承諾
- ❌ 不為了「擴大使用者」而做違背定位的功能

## License

MIT
