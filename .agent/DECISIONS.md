# DECISIONS — Architecture Decision Records

## 1. Event Bus 驅動 UI 動作

**決策**: 所有 user action（close tab、new tab、connect 等）透過 `events.ts` 的 pub/sub emit，副作用集中在 `App.tsx` 的 event handler 處理。

**原因**: UI 元件（TabBar、Sidebar、useKeybindings）只管觸發，不需要知道 pty kill、terminal dispose、persist 這些實作細節。避免同一個邏輯散落在多個檔案。

**不要改**: 如果把副作用分散回各元件，新增 trigger point 時就要到處複製 cleanup 邏輯。

---

## 2. Connector 抽象層（Factory Pattern）

**決策**: `src/main/connector/index.ts` 的 `createConnector(connection)` 根據 connection type + OS 回傳對應實作。IPC handler 呼叫 factory 取得 connector 再操作。Preload 只是 RPC bridge，不含 dispatch 邏輯。

**原因**: 所有 connection-specific 邏輯（spawn、listDir、upload、cleanup）收在各自的 connector 實作裡，消費端（pty-manager、file-transfer、IPC handler）不需要 switch connection type。新增 connection type 只需加一個 connector 檔案 + 註冊到 factory。

**不要改**: 如果把 connection dispatch 散回各消費端，每個用到 spawn/listDir/upload 的地方都要重複 switch。

---

## 3. xterm Instance Cache

**決策**: `TerminalView` 用全域 Map cache xterm instance，tab 切換時不 destroy/recreate。

**原因**: xterm.js 初始化成本高（DOM 操作、WebGL context），cache 讓 tab 切換瞬間完成且保留 scrollback。

**不要改**: 如果每次切 tab 都 destroy + recreate，會丟失 scroll 位置和歷史內容。

---

## 4. SSH ControlMaster Multiplexing

**決策**: SSH 連線使用 `ControlMaster=auto` + `ControlPersist=600`，同 project 多個 tab 共用 TCP 連線。

**原因**: 避免每開一個 tab 都重新認證和握手。600 秒 persist 讓短暫斷開的 tab 不需要重連。

**不要改**: 不用 ControlMaster 的話每個 tab 獨立 SSH 連線，開 5 個 tab = 5 次認證。

---

## 6. Lazy Connect

**決策**: App 啟動時只載入 project 列表，不自動 spawn terminal。用戶點擊或按 Enter 才連線。

**原因**: 用戶不一定需要同時連所有 project。SSH 連線成本高，自動連線會拖慢啟動。

**不要改**: 自動連線在 project 多時會 spawn 大量 pty，浪費資源且拖慢啟動。

---

## 7. userData 隔離靠 Electron 內建訊號

**決策**: `src/main/user-data-path.ts` 的 `applyUserDataIsolation()` 在 `index.ts` top-level 呼叫一次（idempotent guard）。判斷邏輯：
- `app.isPackaged === true` → packaged 安裝版 → 保留 OS-default 路徑（prod）
- `app.commandLine.hasSwitch('user-data-dir')` → E2E tempdir 自己指定 → 不動
- 其他（dev、`npx electron .`、`npm run pack`）→ OS-default 路徑加 `-dev` 後綴

E2E 測試在 `e2e/helpers.ts` 每個 worker `mkdtempSync` 一個 tempdir，啟動帶 `--user-data-dir=<tempdir>`，結束 `rm -rf`。**NODE_ENV 不參與 userData 決策**。

**原因**: 舊版靠 `NODE_ENV` 當 gate，本地 `npx electron .` / `npm run pack` 沒帶就寫進正式 userData（v0.5.0 `projects.json` 遺失事件）。`app.isPackaged` 是 Electron 原生訊號，packaged runtime 直接讀，不需要 build-time inline。Safe-by-default：任何 unpackaged 啟動都自動掛 `-dev`。

**不要改**:
- 把 gate 換回 `NODE_ENV` → 回到 v0.5.0 bug
- 把 fallback 拿掉變成「isPackaged 以外都寫 OS-default」→ safe-by-default 失效
- 把 `applyUserDataIsolation()` 搬進 `whenReady` → 晚於 Electron 內部初始化（Cookies、Cache），部分資料寫錯路徑
- E2E 改回 `NODE_ENV=test` 推算路徑 → worker 無法併行、會刪到 dev userData

---

## 8. Settings Shallow Merge with Defaults + Deep Merge Keybindings

**決策**: `loadSettings()` 用 `{ ...DEFAULT_SETTINGS, ...saved }` merge，新增 setting key 時舊的 settings.json 自動補預設值。`keybindings` 額外做 deep merge（`{ ...DEFAULT_KEYBINDINGS, ...saved.keybindings }`），確保新增的快捷鍵不會被舊設定覆蓋掉。

**原因**: 向前相容。用戶升級版本後不需要手動加新欄位。keybindings 是巢狀物件，shallow merge 會讓舊存檔整個覆蓋 defaults，導致新快捷鍵消失。

**不要改**: 如果直接讀 saved 不 merge，舊版 settings.json 缺少新欄位會 crash。如果 keybindings 不 deep merge，每次新增快捷鍵都要手動刪 settings.json 才能生效。

---

## 11. Terminal 持久渲染（不 unmount）

**決策**: 所有 project 的所有 tab 都持久渲染，用 `display: none` 隱藏非 active 的。切換 project/tab 只改 visibility。

**原因**: 如果只渲染 activeProject 的 tabs，切換 project 時 React unmount → remount → 重新 spawn pty，丟失 terminal 狀態。

**不要改**: unmount/remount 會導致 pty 重複 spawn 和 terminal 內容遺失。

---

## 12. TerminalView 是唯一 spawn 點

**決策**: 只有 `TerminalView` 的 useEffect mount 時呼叫 `pty.spawn`。Event handler（NEW_TAB、CONNECT_PROJECT）只負責 `addTab()`。

**原因**: 之前 event handler 和 TerminalView 都 spawn，導致每個 tab 被 spawn 兩次。

**不要改**: 如果在 event handler 也 spawn，會跟 TerminalView mount 重複。

---

## 13. 檔案上傳統一走 `<cwd>/.tmp/shelf/`，不用 `/tmp/shelf-paste`

**決策**: 所有 paste / drag-drop 上傳的目的地都是 `<projectCwd>/.tmp/shelf/<prefix>-<filename>`，而不是過去的 `/tmp/shelf-paste/`。Local / SSH / Docker / WSL 共用同一個 `connector.uploadFile` 入口。

**原因**:
- 沙盒過的 agent CLI（Claude Code、Gemini、Codex）只能讀 project 內的檔案，丟到 `/tmp` 它會回 permission denied。
- 路徑跟著 project 走，不會在 `/tmp` 留下跨 project 的孤兒檔。
- `.tmp/` 慣例上 git-ignorable，使用者可以一鍵清掉。

**不要改**: 換回 `/tmp` 會直接打破 sandboxed agent 的使用情境。

---

## 14. 上傳一律 cat-via-stdin，不用 scp / docker cp

**決策**: SSH / Docker / WSL 三種 transport 在 `file-transfer.ts` 都用同一個 pattern：
`spawn('<bin>', [...args, 'sh', '-c', "mkdir -p '<dir>' && cat > '<path>'"])` 然後把 buffer 灌進 stdin。

**原因**:
- **不用 staging file** — 不再需要先寫 `os.tmpdir()/shelf-paste/xxx` 再傳出去，也不會有 staging 漏掉沒清的問題。
- **不用 scp 的 remote-shell 解析** — scp 在遠端會把路徑跑過一次 shell，filename 含空白／引號就會炸；改用 `cat >` 後路徑只經 single-quote 一層。
- **三種 transport 對稱** — 同一個 helper（`spawnPipeWrite`）三邊複用，新增 transport 只要再寫一個 wrapper。

**不要改**: 退回 scp 會把 staging cleanup、cross-shell quoting、binary safety 三個雷一次踩回來。

---

## 15. Updater state machine 抽成純 reducer

**決策**: 自動更新的狀態轉移放在 `updater-state.ts` 的 `reduceUpdaterStatus(state, event)` 純函式裡。`updater.ts` 只負責接 electron-updater event 與 IPC，呼叫 reducer 後 broadcast。

**原因**:
- electron-updater 的 singleton 在單元測試裡沒辦法 mock 乾淨；把 transition 邏輯抽出來後 reducer 可以用 vitest 直接測（21 個 case 涵蓋每個事件 × 每個狀態的 guard）。
- 用 reducer 才能集中表達「下載中收到 not-available 不能 clobber」「error 從 downloading 退回 available 讓使用者重試」這類細節。

**不要改**: 把 transition 寫回 `updater.ts` 的 event handler 裡會讓行為再次無法測試，並讓 guard 散落各處。

---

## 16. Bootstrap 在開窗前先載入 config，失敗時 blocking dialog

**決策**: `app.whenReady()` 裡先呼叫 `bootstrap()` 同步載入 `projects.json` 和 `settings.json`，再 `createWindow()`。`loadProjects` / `loadSettings` 回傳 `LoadResult` discriminated union（`ok | parse | permission | read`），bootstrap 根據錯誤型別跳對應的 `dialog.showMessageBoxSync`：parse 給「Quit / Backup & Continue」、permission/read 只給 Quit。

**原因**:
- 過去 config 損毀時 silent 退回 default，使用者不會意識到自己的 project 列表「不見了」直到下次儲存覆寫。
- Sync dialog 在 ready 階段是少數能 block 的時機；window 都還沒開，視覺上不會看到半成品的 UI 又跳錯。
- E2E 測試用 `SHELF_BOOTSTRAP_DIALOG_RESPONSE=quit|continue` env 變數 mock dialog 回應，避免測試卡在 native 對話框。

**不要改**: 把 dialog 推到 createWindow 之後 / 用 async dialog 會讓 race condition 變多（renderer 已經跟 main 要 cachedProjects 但 cache 還沒填）。

---

## 17. Vitest config 獨立檔，不繼承 vite.config.ts

**決策**: `vitest.config.ts` 是另一份獨立 config，不 extend `vite.config.ts`。

**原因**: `vite.config.ts` 載入 `vite-plugin-electron`，跑單元測試時會嘗試 spawn Electron，整個 vitest 就卡死。獨立 config 跑純 TypeScript 模組就好。

**不要改**: 兩份 config 共用會把 electron plugin 拉進 test 環境。

---

## 18. App 快捷鍵在 Capture Phase 攔截 + stopPropagation

**決策**: `useKeybindings` 在 window capture phase 監聽 keydown。匹配到已註冊的快捷鍵後執行 action 並 `preventDefault` + `stopPropagation`，事件不會到達 xterm。

**原因**: xterm 會攔截大部分鍵盤事件（包括 Ctrl+D、Ctrl+T 等）。用 capture phase + stopPropagation 確保 app 快捷鍵優先於 xterm。新增快捷鍵只需在 types + defaults + useKeybindings 註冊，不需要改 TerminalView。

**不要改**: 如果讓 xterm 先收到事件再判斷要不要放行，每新增一個快捷鍵都要同步改 TerminalView 的 `attachCustomKeyEventHandler`。

**例外**: Windows/Linux 的 Ctrl+V（paste）和 Ctrl+C（copy when selected）不是 app 快捷鍵，是瀏覽器原生行為。這兩個在 TerminalView 的 `attachCustomKeyEventHandler` 裡 return false 讓瀏覽器處理。

---

## 19. 上傳清理：session-based、cutoff 從檔名解出來

**決策**: `<cwd>/.tmp/shelf/` 清理走兩條路：
- **自動**：project 在 Shelf process 內第一次 spawn pty 時，`maybeScheduleCleanup()` 排 3 秒後 fire-and-forget cleanup。同 project 在 process 內只跑一次（`cleanedProjects` Set 去重）。Cutoff 是 `SESSION_STARTED_AT`（process 啟動時 ms），比這個舊的刪。
- **手動**：ProjectEditPanel 的 Clear 按鈕無視時間戳直接清空。

過期判斷從**檔名解出**：upload prefix 是 `Date.now().toString(36) + counter`，`parseUploadPrefix()` 反解回 ms，不依賴 mtime。

**原因**:
- `find -mmin` 解析度是「捨入到下一分鐘」，會誤刪剛 paste 的檔。Filename-encoded ts 精確到 ms
- 四種 transport 只需要 `ls` + `rm`，不需要 `find` / `stat`
- `parseUploadPrefix` 對非 Shelf prefix 回 `null`，user 自己的檔不會被掃
- Fire-and-forget + 3 秒延遲讓 first paint 不被 cleanup 卡到，錯誤只 log 不 throw

**不要改**:
- 換回 mtime cutoff → 踩 `find -mmin` 捨入問題
- Cleanup `await` 在 spawn 之前 → 遠端 exec 延遲直接打到開 tab 時間
- 拿掉 dedupe → 每次 spawn 都重跑 cleanup，浪費 SSH/docker exec

---

## 19b. Worktree 是獨立 Project

**決策**: Git worktree 以獨立 project 存在於 sidebar，透過 `parentProjectId` 關聯 parent project。繼承 parent 的 connection 設定。Worktree path 放在 parent cwd 的同層目錄（`<parentDir>/<projectName>-<branchName>`）。

**原因**:
- 把 worktree 當 sub-project 保持 sidebar 扁平架構，不需要巢狀 tree view 和複雜的拖曳邏輯。
- Worktree 鎖定一個 branch，行為上就是一個獨立的工作目錄，跟 project 概念一致。
- 放同層目錄（非 repo 內部）避免需要 `.gitignore` 排除。

**不要改**: 如果把 worktree 做成 project 的子層級，sidebar 要從 flat list 變 tree，拖曳排序邏輯會複雜很多。

---

## 20. Connector exec() 方法

**決策**: `Connector` 介面加 `exec(cwd, cmd)` 方法，用於在目標環境執行非互動式指令（如 git 操作）。各 connector 實作對應的 execFile 呼叫。Git IPC handler 透過 connector.exec() 執行，不直接暴露 exec 到 renderer。

**原因**: git worktree 操作需要在遠端（SSH/Docker）執行指令，透過 connector 抽象層可以統一處理，不需要針對每種 connection type 寫不同的 git 邏輯。只暴露特定 git IPC channel 而非通用 exec，避免安全風險。

**不要改**: 不要在 preload 暴露通用 exec API。

---

## 21. Branch 切換用 connector.exec()，Worktree branch 跳轉而非 checkout

**決策**: BottomBar 的 branch dropdown 切換用 `connector.exec('git checkout')`，前置用 `git status --porcelain` 檢查 dirty 狀態。Worktree-occupied branch 標示 "worktree"，點擊跳轉到對應 project（或自動建立），不嘗試 checkout。

**原因**: Worktree branch 不能 checkout（git 限制）。用隱藏 tab 跑 git 指令的話 shell exit code 不可靠。

**不要改**: 不要用隱藏 tab 跑 git checkout。不要把 worktree branch 設為 disabled — user 會困惑為什麼不能點。

---

## 22. Unicode11Addon 預設不啟用

**決策**: xterm.js Unicode11Addon 仍然載入（註冊可用版本），但預設不啟用 `activeVersion`。使用者可在 Settings 勾選 "Unicode 11" 開啟。

**原因**: Unicode11Addon 對 Ambiguous width 字元（如 oh-my-zsh prompt 中的 `→` `✗`）的寬度計算與 zsh 不一致，導致 tab completion 時字元重複顯示。這是 xterm.js 已知限制（#1453）。預設關閉避免大多數使用者踩到此問題。

**不要改**: 不要完全移除 Unicode11Addon（部分使用者需要 CJK/emoji 支援）。

---

## 23. PM Scrollback 讀取走 Main Process Ring Buffer

**決策**: pty-manager 的 `onData` callback 同步寫入 per-tab ring buffer（100KB cap），PM tools 直接從 buffer 讀取 + ANSI strip。不走 renderer IPC round-trip 取 xterm buffer。

**原因**: xterm buffer 在 renderer，main→renderer 的 invoke 需要 request-response dance。Ring buffer 在 main process 直接可用，不依賴 renderer 存活，且 memory bound（50 tabs × 100KB = 5MB）。

**不要改**: 不要改成 main→renderer IPC 取 xterm buffer — 會增加延遲、且 renderer 最小化時可能不回應。

---

## 24. PM 用 OpenAI-compatible API Format（無新 npm dependency）

**決策**: `llm-client.ts` 用 Electron `net.fetch` 直接打 OpenAI-compatible chat/completions endpoint + SSE streaming，不依賴任何 SDK。使用者在 PM settings 填 baseUrl + apiKey + model。

**原因**: 支援 Gemini（免費 tier）、OpenAI、Anthropic（OpenAI-compatible endpoint）等多家 provider，不需要 per-provider SDK。`net.fetch` 繞過 CORS 限制。

**不要改**: 不要加 `openai` 或 `@anthropic-ai/sdk` dependency — PM 的需求（chat + tool use + streaming）用 raw fetch 足夠。

---

## 25. Away Mode 是全域 Toggle，非 Per-Task

**決策**: Away Mode 是單一 boolean toggle，OFF = 使用者控制 terminal、PM 只讀，ON = PM 可寫、terminal 顯示 read-only overlay。重啟預設 OFF。

**原因**: 單一 state 好推理、符合「我要離開電腦了」的直覺動作、避免 per-task 主導權追蹤的 edge case。

**不要改**: 不要做 per-tab 或 per-project Away Mode — 狀態爆炸。

---

## 26. write_to_pty 的三層保護

**決策**: `write_to_pty` tool 有三層保護：(1) Away Mode OFF 時整個 tool 不 expose 給 LLM，(2) idle_shell 狀態下拒絕寫入（防止 CLI crash 後寫進 raw shell），(3) 硬紅線 pattern match（rm -rf、git push --force 等）命中時拒絕並走 escalation。

**原因**: PM 送的對象應該是 CLI agent，不是 raw shell。三層保護確保即使 LLM 推理出錯也不會造成破壞。

**不要改**: 不要移除 idle_shell guard — 這是防止 CLI crash 後 PM 直接打 shell command 的最後防線。

---

## 27. PM/DevTools 共用右側 Panel + 收合欄

**決策**: PM 和 DevTools 都以右側可拖拉 panel 存在，收合時共用 `.right-tabs-collapsed` 容器（單一 28px 欄），label 垂直堆疊。App.tsx 統一管理收合 tab 渲染，各 panel 不自己 render。PM 不放 Sidebar、不做全頁切換。

**原因**: PM 和 terminal 需要同時可見（邊看 terminal 邊跟 PM 對話），放 Sidebar 會跟 project 列表衝突，全頁切換會失去 terminal 可見性。兩個獨立 28px 收合欄太寬，統一容器視覺乾淨且方便未來加更多 panel。

**不要改**: 不要把 PM 放回 Sidebar 或做全頁切換。不要讓各 panel 自己 render 收合 tab。

---

## 29. Settings 左側 Tab 分頁

**決策**: SettingsPanel 分三個 tab：Terminal / PM Agent / Shortcuts。左側固定 120px 導航欄，右側內容區 scrollable。面板固定 height: 70vh。

**原因**: 加了 PM provider + Telegram 欄位後 Settings 太長，分頁讓內容分類清楚。固定高度避免切 tab 時畫面抖動。

**不要改**: 不要回到單頁長列表。

---

## 30. PM 資料全部存 userData

**決策**: PM 的所有持久化資料都存在 `app.getPath('userData')` 下：`settings.json`（provider + telegram config）、`pm-history.json`（對話）、`pm-notes/`（project notes）、`pm-global-note.md`（跨 project 記憶）。

**原因**: userData 路徑跟隨 dev/test/prod 隔離（user-data-path.ts 的 `-dev` 後綴 + E2E tempdir）。之前放 `~/.config/shelf/` 會跨環境共用，dev 和 prod 打架。

**不要改**: 不要把 PM 資料搬回 `~/.config/shelf/`。

---

## 31. Agent View：兩 provider 都用各自原生 SDK + bundled CLI

**決策**: Agent tab 直接呼叫 AI provider SDK（不是解析 terminal scrollback）：
- Claude → `@anthropic-ai/claude-agent-sdk`，spawn bundled `claude` binary
- Copilot → `@github/copilot-sdk`，spawn bundled `@github/copilot` CLI（SDK 是 JSON-RPC wrapper，CLI 才是實際執行體）

兩者都在 `agent-server` bundle 裡執行，透過 stdin/stdout JSON line protocol 跟 main process 通訊。Binary 透過 `electron-builder` 的 `files` + `asarUnpack` 打包進 app（per-platform：claude-agent-sdk-{darwin|linux|win32}-{arch}、copilot-{darwin|linux|win32}-{arch}）。

**原因**:
- 之前用 terminal scrollback parsing 偵測 agent 狀態，TUI rendering 讓 stripped text 不可識別，永遠回傳 `cli_running`。直接用 SDK 拿到 structured state（idle/streaming/waiting_permission）。
- Copilot 試過 Vercel AI SDK（直打 `/chat/completions` + `/responses`）但 multi-turn 死路：Copilot 不支援 `store: true`、`previous_response_id`，replay history 又因 tool_call ID server 不認 404。Copilot CLI 本身解決了 stateful 對話，SDK 只是 wrap 它。
- 兩條路徑現在對稱：spawn bundled CLI binary、依賴使用者已有的官方 CLI 登入狀態（不經手 token）。

**不要改**:
- 不要嘗試自己對 Copilot 的 OpenAI-compatible endpoint 做 multi-turn — 已驗證走不通
- 不要把 binary 改成 runtime 下載 — 第一次使用會等很久，且需要 network；bundle 進 app 是體積換體驗

---

## 32. Agent Server 是 esbuild 單一 Bundle

**決策**: `agent-server/` 用 esbuild 打包成 `dist/agent-server/<version>/index.js` 單一 ESM bundle，deploy 到遠端（SSH: `~/.shelf/agent-server/index.js`，Docker: `/root/.shelf/agent-server/index.js`）。Main process 的 `remote.ts` 自動 SCP/docker cp。

**原因**: agent-server 依賴 Claude SDK / Copilot SDK，不能期望遠端有 node_modules。Single bundle 讓 deploy 只需要複製一個檔案 + `node index.js`。Binary（claude/copilot CLI）由 main process 從 ASAR unpacked 路徑解析後傳 cliPath 給 SDK。

**不要改**: 不要在遠端跑 npm install — 會拖慢啟動且需要 network。

---

## 33. Dual-Mode Tab State Detection

**決策**: Tab 狀態偵測分兩條路：Agent tab → `getAgentState()` 從 session manager 拿 structured state；Terminal tab → scrollback heuristic（既有的 `inferTabState`）。`resolveTabState()` 在 `tab-watcher.ts` 統一派發。

**原因**: Agent tab 有 structured state（SDK 直接回報），比 scrollback parsing 準確。Terminal tab 沒有 SDK，只能用 heuristic。兩者不互斥。

**不要改**: 不要嘗試統一成單一偵測機制 — agent tab 和 terminal tab 的資訊來源根本不同。

---

## 34. Agent Tab 固定 Provider，每 Project 每 Provider 至多一個

**決策**: Agent tab 建立時綁定一個 provider（claude 或 copilot），不可在 tab 內切換。UI 層限制同一個 project 不能開兩個相同 provider 的 agent tab（`addTab()` 檢查 + TabBar menu disabled）。Backend 透過 tabId-based session 管理，架構上不限制數量。

**原因**: Provider 切換涉及完全不同的 context/session 管理（Claude SDK session vs Copilot modelMessages），切換後前一個 provider 的對話無法保留。固定綁定讓 sessionId 跟 provider 一對一，persistence 邏輯簡單。UI 限制一個是因為同 provider 開兩個 tab 沒有實際用途，但 backend 不硬限是為未來擴展保留空間。

**不要改**: 不要做 tab 內 provider 切換 — context 不相容。不要在 backend 層也限制一個 — UI 層限制已經足夠。

---

## 35. Agent 雙層持久化：Server-side Context File + Client-side IndexedDB

**決策**: Agent 對話持久化分兩層：
- **Server-side**（`~/.shelf/agent-context/{sessionId}.json`）：Copilot 存 `modelMessages`（會被 compaction 壓縮）/ `lastResponseId` 用於 API 呼叫；Claude 存 `lastSdkSessionId` 作為 SDK `options.resume` 的指針（對話本體在 SDK 自管的 `~/.claude/projects/`），詳見 #38
- **Client-side**（IndexedDB `shelf-agent-history`）：存完整 UI messages（含 user messages、tool calls 展開等），用於重新開啟 tab 時恢復顯示

SessionId 是 UUID v4，存在 `ProjectConfig.agentSessionIds[provider]`，兩層用同一個 key。

**清理策略**：
- Server-side：agent-server 啟動時掃描，移除 `updatedAt` 超過 30 天 + 損壞 JSON
- Client-side：remove project 時清對應 session，不做定期掃描（在本機且跟 project 生命週期綁定）

**原因**: Server-side context 被 compaction 或 SDK 管理，無法恢復原始 UI。IndexedDB 在 renderer 直接可用，不需要 IPC round-trip。Context 檔在遠端機器累積無人清，30 天 cutoff 涵蓋合理 resume 需求。

**不要改**:
- 不要合併成單一 persistence — compacted data 無法恢復原始 UI
- 不要用 file 替代 IndexedDB — renderer 讀寫 file 需要 IPC
- 不要在 client 端觸發 server-side 清理 — 要走 IPC + SSH exec，太複雜

---

## 37. PM 回覆用 marked 渲染 Markdown

**決策**: Assistant 訊息用 `marked` 套件（zero-dependency, 449KB）渲染成 HTML，透過 `dangerouslySetInnerHTML` 顯示。User 訊息維持純文字。Streaming 時也即時渲染。

**原因**: PM 回覆常帶 code block、list、table，純文字不可讀。Electron 本地環境無 XSS 風險（資料來源是 LLM 回覆）。marked 是 zero-dependency 且夠輕量。

**不要改**: 不要自幹 regex markdown parser — edge case 太多。不要用 `react-markdown`（dependency chain 太長）。

---

## 38. Claude Auto-Resume 純 Server-Side（含跨 process 持久化）

**決策**: Claude session resume 完全在 `agent-server/providers/claude.ts` 處理。

- **同 process 內**：SDK 回傳的 `session_id` 存在 `lastSessionId` 變數，下次 query 自動帶入 `options.resume`
- **跨 process（app 重啟、agent-server child restart）**：每個 turn 結束 `finally` 把 `lastSessionId` 寫入 `~/.shelf/agent-context/<sessionId>.json` 的 `lastSdkSessionId`；下次 process 啟動時 `seedSessionFromDisk(sessionId)` 把它讀回 `lastSessionId`，後續走原本路徑

Seed 時機：`gatherCapabilities` 結尾（tab 開啟時必跑）+ `query()` 入口（防 capabilities 被 cache short-circuit）。同一 sessionId 一個 process 只 seed 一次（`seededSessions` Set）。Client 端也可透過 `QueryInput.resume` 顯式覆蓋。

**原因**:
- Claude SDK 的 resume 機制只需要一個 session_id string，server 端自己追蹤最簡單
- jsonl 對話本體在 SDK 自管的 `~/.claude/projects/<cwd-hash>/<id>.jsonl`，**和我們的 `agent-context/` 共處同一台機器**（agent-server 在 local connection 跑本機、SSH/Docker 跑遠端，指針和本體永遠同處），所以指針持久化才有意義
- 一個 turn 寫一次盤（不是每 chunk）— 避免 disk thrash
- Crash mid-turn 最差只丟掉這個 turn，下次 resume 從上一個 turn 的 session_id 開始（SDK 一條 jsonl 內就含上次 turn 的全部 history）

**不要改**:
- 不要把 SDK session_id 暴露給 client — 增加 IPC 複雜度且沒有實際好處
- 不要每 chunk / 每 message 寫盤 — 一個 turn 一次足夠
- 不要把 `lastSdkSessionId` 存進 `projects.json`（project config）— 高頻寫入會 rewrite 整個 projects.json，且這是 backend implementation detail 不該污染 user-facing config
- Docker connection 是已知限制：container 重建即丟（`~/.shelf/agent-context/` 跟 jsonl 都在 container 內），不要為此繞回 main process 存（指針在本機沒用，因為 jsonl 在 container 內）

---

## 39. PM 不直接執行任何操作，唯一輸出通道是 write_to_pty

**決策**: PM 沒有 Bash / Edit / Write / 直接 file system 操作 tool。所有「動作」都透過 `write_to_pty` 對 terminal tab 送資料，由跑在 terminal 裡的 CLI agent（Claude Code、Copilot CLI 等）實際執行。

**原因**:
- 真正的破壞性操作由各 CLI 自己的 permission 層把關，PM 不重複造輪子
- PM 永遠沒有 cwd / connection / sandbox 問題（不在 Shelf process 跑指令，是「打字進 terminal」）
- 遞迴防範天然成立 — CLI agent 看不到也呼叫不了 PM 的 tool
- Telegram 橋接天然安全 — PM 頂多讓 CLI 收一則 prompt
- write_to_pty 的三種語意（prompt / approve-deny / 中斷）由 PM 決定送什麼，但都是同一個 tool

**代價**:
- PM 理解 CLI 狀態靠解析 scrollback（非結構化），可能有解析誤差 — Decision #33 的 dual-mode detection 部分緩解
- Project 沒開 CLI 的 terminal tab 時 PM 無法指揮（user 需先手動開好）

**不要改**: 不要為 PM 加 Bash / Edit / Write tool — 一旦給了 PM 就有 cwd / sandbox / 權限 escalation 三個雷要踩。CLI 已經處理好的東西不要重做。

---

## 40. PM 對話是單一 thread，Shelf UI 與 Telegram 合併

**決策**: PM 的對話是一條無限長的 thread。Shelf UI 和 Telegram 是同一條 thread 的兩個 view。任一端發訊息都 push 到另一端，dedupe 確保不重複，順序保證處理 race。

**原因**:
- 符合「PM 是同一個實體」的直覺 — user 在 Shelf 聊一半出門用 Telegram 繼續問，PM 有連續記憶
- 不需要在兩端維護獨立 history 或做 sync 比對
- Compact / Clear 行為一致（兩端看到同一條 thread 被壓縮或清空）

**實作要點**:
- 原則性 prompt 一律放 system prompt（`/clear` 不動、`/compact` 不壓）
- 不放在 history 前綴 — 會被 clear 掉

**不要改**: 不要為 Telegram 拆出獨立 conversation — 會造成「我剛在 Shelf 講過」但 Telegram 端 PM 不知道的斷層。

---

## 41. PM 雙層 Prompt（System + Per-turn Reminder）

**決策**: PM 的 prompt 分兩層：
1. **System prompt**：放原則、紅線清單、授權邊界定義、Note 維護規則 — `/clear` 不動、`/compact` 不壓的可靠 pin 位置
2. **每次 user-originated task 前綴**：wrap 一層「Reminder: 授權邊界 = [user 最後明確指令]，超出 escalate」 — 對抗 recency bias

**原因**:
- 長對話容易被近期 user turn 帶偏離原則（recency bias）
- System prompt 是 LLM 看得最重的位置，但太遠會被淡化 — per-turn reminder 補強
- 硬紅線（rm -rf 等）不純靠 prompt — 在 `write_to_pty` handler 的 pattern match 強制（Decision #26）
- Compact-resilient — 原則放在 compact 不會動到的位置，確保長對話不漂移

**不要改**:
- 不要把原則放 history（會被 `/clear` 清掉）
- 不要拿掉 per-turn reminder，只靠 system prompt — 在長 history 後 system prompt 影響力會下降
- 不要把硬紅線從 code 層搬到純 prompt — 紅線是 last line of defense，prompt 不可信

---

## 42. Project Note 用 Rolling Summary 格式

**決策**: Project note (`<userData>/pm-notes/<projectId>.md`) 採固定四區段 markdown 結構，PM 每次 read-update-write 整張卡：

```markdown
# Project Name

**Last update**: <timestamp>

## Active
- 進行中的任務（含啟動時間、進度、blocker）

## Recently done (keep briefly)
- 1-2 條剛完成的事，超過合併或丟

## Open loops
- 已知但尚未解決的問題

## Context hints
- User 偏好、約定、歷史脈絡
```

**規則**（寫在 PM system prompt 強制執行）:
- 總長度硬上限 ~300 字 / 2KB
- 新事件優先，舊事件越久越壓成一句或刪除
- Recently done 只留 1-2 條
- Open loops 除非明確解決否則保留
- 每次碰到 project：`read_project_note` → 做事 → `write_project_note`（覆寫整張）

**原因**:
- **Single snapshot**（只留最後一條）→ 平行多任務 context 蒸發、Open loops 被覆寫
- **Append log**（無限累積）→ token 成本爬升、舊資訊稀釋新的
- **Rolling summary** → PM 每次 write 時自己合併壓縮，大小受控但保留多任務脈絡

**不要改**:
- 不要把 note 換成 append-only log — 會無限膨脹
- 不要拿掉 size 上限 — PM 不自我約束會無限膨脹
- 不要讓 user 直接編輯 note 當「寫 PM 指示」用 — PM 下次 write 會覆蓋。要影響 PM，請 PM 同步或改寫

---

## 43. Agent Provider 行為對外保持一致，差異封裝在 Provider 內部

**決策**: 所有 agent provider（Claude / Copilot / 未來其他 OpenAI-compatible）對 renderer 暴露同一組介面（`gatherCapabilities`、`query`、`stop` 等）。Provider 之間的行為差異（model list 來源、slash command 語意、context 管理策略、auth 流程）一律封裝在 provider 內部。Renderer 對 provider type 無知。

**典型差異點**:
- **Model list**：Claude 寫死 / Copilot API 動態抓 / 未來 generic 由 user 配置 → 一律經 `gatherCapabilities().models` 出來，client 不用判斷怎麼來的
- **Slash commands**：provider 在 `query()` 入口自行偵測 `/cmd` prefix 並內部 dispatch（見 #54）— renderer 不分流
- **Context 管理**：Claude SDK 自管 / Copilot modelMessages + auto-compact → 都在 provider 內部
- **Auth**：Claude OAuth token / Copilot session token → 都包成 `auth_required` event

**原因**:
- 新增 provider 不需改 renderer — 只要實作介面
- Provider-specific 邏輯散到 renderer 會造成：(1) 每加一個 provider 都要改前端；(2) 前後端改動偶合；(3) `if (provider === 'claude') ... else if ('copilot') ...` 的鬼故事到處長
- 行為差異隔離後可以分別演進 — Copilot 加新 slash command 不會影響 Claude 路徑
- IPC contract 穩定 — provider 內部重構不影響前端

**反例（不該這樣做）**:
- Renderer 寫死 `if (provider === 'copilot') ...` 攔截特定 slash command
- Renderer 知道某個 provider 的 model list 要動態 refetch、另一個不用
- Status bar 或 SettingsPanel 為某個 provider 開特殊 UI 分支
- IPC payload 帶 provider type 讓 main / agent-server 判斷怎麼處理

**例外**: 純 UI 呈現（例如 provider 名稱顯示為 "Claude" / "Copilot"）可以在 renderer 處理 — 那是 i18n 等級的東西，不是 agent 邏輯。

**不要改**: 不要為了「圖方便」在 renderer 加 provider-specific 條件分支 — 短期省 5 行 code，長期回頭重構要付 5 倍代價。新需求進來時先問「能不能塞進 provider 介面」，不行才考慮擴介面，最後才動 renderer。

---

## 45. Copilot 走 gh CLI auth，token 完全不經手

**決策**: `CopilotClient` 啟動時：
- `useLoggedInUser: false`（關掉 SDK 內建的 keychain/plaintext token 探測）
- 我們自己跑 `gh auth token` 拿 token，傳 `gitHubToken` 明確覆寫
- 沒有 gh / 沒登入 → throw 提示「`gh auth login -s copilot`」

**原因**:
- Copilot CLI 預設把 OAuth token 存 macOS Keychain（key=`copilot-cli`），首次從 Electron 內 spawn CLI 會跳 `node 想存取 copilot-cli` 的系統提示，UX 嚇人
- 跟 Claude 一致：我們不經手 token，依賴使用者本機官方 CLI（Claude Code / gh）的登入狀態 — Decision #43 的 provider 抽象原則
- `gitHubToken` 在 SDK 是「最高優先」覆寫，會跳過 keychain 探測那條 code path，**完全不觸發 macOS 提示**

**不要改**:
- 不要回去用 `useLoggedInUser: true` — 會跳 keychain 提示
- 不要自己存 token 到 userData — keychain ACL 是 per-binary 綁定，自存只是把 GitHub 的 OAuth refresh 邏輯重做一遍

---

## 46. Sticky Plan Panel：兩 provider 都接 plan 訊息

**決策**: AgentView 在 input 上方有個固定 panel，顯示當前 plan/todos 狀態。Backend 透過 `{ msgType: 'plan', content }` 訊息覆蓋式更新。Replace-semantics（每次直接覆蓋整段內容），content 為空字串時 panel 隱藏。

**兩 provider 接法不同**：
- **Copilot**：`session.plan_changed` 事件 → debounced 呼叫 `session.rpc.plan.read()` → 發 `plan`
- **Claude**：攔截 `tool_use` block，`TodoWrite` 把 `todos` 陣列轉 markdown checkbox（`[x]`/`[~]`/`[ ]`）；`ExitPlanMode` 直接用 `input.plan` 字串
- 兩 provider 的 `/clear` 都要主動發空 `plan` 清 panel

**命名歷史**: 早期叫 `plan_update`，2026-05 配合 canonical msg type 重構（見 #52）改名為 `plan` —— union 內其他 type 都是名詞，rename 對齊。

**原因**:
- Plan/todo 是「持續被 mutate 的單一 state」，不適合塞在 chat history 裡（會洗版、看不到當下狀態）
- Plan panel 跟 message list 視角互補：panel 顯示 latest，list 顯示 history（tool call 何時被呼叫）
- Replace-semantics 跟兩 provider 的原生語意都吻合（Copilot plan 檔覆蓋；TodoWrite 每次傳完整 list）

**不要改**:
- Tool call 不要從 message list 拿掉 — history 視角有用（debug 時看時間軸）
- 不要把 plan panel 做成 collapsible inside chat — 用戶要的是「永遠看得到當前狀態」

---

## 47. Status bar 內容由 provider 決定，renderer 只渲染

**決策**: Status bar 的所有「provider 知識」欄位（rate limit、context %、permission mode、effort）改用統一 schema：
- **純顯示欄位** → `StatusSegment = { text, severity? }`，provider 把 label 翻譯、reset 倒數格式化、severity 判斷全包好，renderer 只做 `data-severity` → CSS color 對應
- **Cycle 欄位** → `CycleOption = { value, displayName, severity? }`，provider 決定每個 option 的顯示字 + 嚴重度，renderer 只負責 cycle UX（按鈕點下去切下一個 value）

Severity 是抽象層級：`'normal' | 'info' | 'warning' | 'critical'`，map 到 CSS 顏色集中在 `.agent-status-seg[data-severity="..."]`。

**原因**:
- Vocabulary 跟 UX 訊號是 provider 領域知識（`five_hour` / `premium_interactions` / `bypassPermissions` 各自的危險程度），散到 renderer 寫 `if rateLimitType === 'five_hour' ...` 就是 Decision #43 違反
- 但 cycle 行為（按一下切下一個）是 UI 互動，硬塞到 data model 裡反而過度抽象 — 所以分兩種 schema：純顯示用 `StatusSegment`，可互動用 `CycleOption`
- 共用 helper（`severityFromUtilization`、`formatResetCountdown`）放 `providers/types.ts`，避免兩 provider copy-paste

**配套**:
- Claude / Copilot 都自己決定 quota label（`5h` / `premium`）跟 severity 邊界（例如 Claude 的 `status: 'rejected'` 即使 utilization 50% 也算 critical）
- 100% 不 cap — overage 真實顯示成 `120%`（Copilot 月配額用爆會超過 100%）
- Permission mode 顯示字也由 provider 決定（`default → ask`、`bypassPermissions` 原樣 + critical 嚴重度）
- Renderer 完全不知道 `five_hour`、`premium_interactions`、`bypassPermissions` 等字串存在

**不要改**:
- 不要把 severity 換成 raw color（`'red'` / `'#e06c75'`）— 失去抽象，主題切換時改不到位
- 不要把 cycle 結構也包成 `StatusSegment` — cycle 行為是 renderer 領域，過度抽象沒效益
- 不要在 renderer 寫 quota / mode 的特殊翻譯（例如 `if (mode === 'plan') color = blue`）— 這是 provider 該決定的，severity 已經傳達意圖

---

## 48. Agent provider custom model registry — Claude merge SDK + user，Copilot 簽名對稱但忽略

**決策**: `gatherCapabilities(cwd, sessionId, customModels?)` 簽名統一加 `customModels?: ProviderModel[]`。Claude 用 pure `mergeClaudeModels()` 把 SDK 動態 list 跟 user 自訂 entry 合併（同 id 以 user 覆寫）；Copilot 簽名收下但函式內忽略 + 註解。

`AppSettings.providerModels` key 從 `PmProviderType` 廣化成 `PmProviderType | 'claude'`。Settings UI 用 `AGENT_PROVIDER_REGISTRY`（目前只有 Claude）多渲染一個 section，行為跟 PM provider section 一致。Main 在 `startSession` 時 `loadSettings()`，把 `providerModels[provider]` 透過 `getCapabilities` → IPC → agent-server 傳到 backend，session 內 closure cache（user 改 settings 要重開 agent tab 才生效，不做 hot reload）。

**原因**:
- Claude SDK `supportedModels()` 只回 4 個 alias（default 1M / opus / sonnet / haiku），抓不到舊版 full ID（如 `claude-opus-4-6`）。User 想用舊版又不想我們寫死預設 list（會跟 SDK drift）
- Copilot SDK server-side 驗證 model 名稱，custom 會被拒；介面對稱但忽略比 throw 更乾淨，未來 API 改了拿掉 `_` 前綴即可
- 不做 hot reload — YAGNI，為一個低頻設定變更寫熱重載成本太高

**配套**:
- `mergeClaudeModels` 是 pure function，獨立測（`agent-server/providers/claude.test.ts`），不 mock SDK
- `ProviderModelsSection` prop 型別放鬆成 `{ id: string; label: string; models: ProviderModel[] }`，同時吃 `PM_PROVIDERS` 與 `AGENT_PROVIDER_REGISTRY` entry
- Models tab hint 改成涵蓋「PM Agent and Claude pickers」

**不要改**:
- 不要在 Settings UI 列 SDK 預設 model — 會 drift；Models tab 只列 user 自訂 entry
- 不要把 Copilot 塞進 `AGENT_PROVIDER_REGISTRY` — SDK 會拒，UI 給 user 設了沒效果只會誤導
- 不要在 renderer 直接讀 settings — 走 main 的 `loadSettings`，避免 renderer 感知 main 的 storage layout

---

## 49. Permission semantics 全部收進 provider，dispatcher 只做 IPC routing

**決策**: 所有跟 permission 相關的行為細節（bypass 短路、acceptEdits 自動允許、plan mode 阻擋、session allowlist「always allow this tool」）都實作在 `agent-server/providers/<name>.ts` 裡。`agent-server/index.ts` (dispatcher) 不存任何 permission 狀態、不做任何 mode 判斷，只負責 IPC routing 和 backend lifecycle。

**原因**:
- 跟 vocab mapping 同一套權責原則（Decision #43）：provider 是 SDK adapter，把 SDK 特性 normalize 成 canonical interface；dispatcher / renderer 不知道 SDK 細節
- 兩 provider 的 SDK 對 permission 的支援深度本來就不一樣 — Claude 有 `updatedPermissions` (PermissionUpdate addRules destination=session)、Copilot 用 `kind`-based 粗粒度 + native `autopilot` SessionMode。硬抽到 dispatcher 會把差異當 edge case 處理，放棄各自 SDK 最原生的機制
- session allowlist 在 Claude 是「白送」（回 `updatedPermissions` 後 SDK 自己接管，連 `canUseTool` 都不會再 invoke）；dispatcher 一律「自己存 Set」就丟掉這個白賺
- 加新 provider 時不用改 dispatcher

**配套**:
- `bypassPermissions`：Claude 在 `canUseTool` 開頭 short-circuit auto-allow，SDK 的 `permissionMode` 一律送 `'default'`（避開 `allowDangerouslySkipPermissions` 旗標）；Copilot 走 native `autopilot` SessionMode
- `plan` / `acceptEdits`：Claude 透傳 SDK（兩者 SDK 內建語意非平凡，不要重造）；Copilot adapter 自己決定怎麼對應（`acceptEdits` 目前無對應就從 capability list 拿掉，"honest capability surface"）
- session allowlist (未來)：Claude 用 SDK `updatedPermissions: [{type:'addRules', destination:'session', ...}]`；Copilot 看 SDK 支援度，沒對應就 provider 內 closure `Set<string>` fallback
- Permission popup 第三按鈕「Allow for session」由 renderer 加，但「session allow 之後怎麼記住」是 provider 的責任
- **Capability descriptor（label / severity）走中央定義**：`PERMISSION_MODES` / `EFFORT_LEVELS` 放 `agent-server/providers/types.ts`，provider 用 `pickPermissionModes(['default', 'plan', ...])` 宣告支援哪些 ID。Provider 自證「我支援什麼」，不重複定義 displayName 或 severity（那是 app 層級的 UX 一致性）

**不要改**:
- 不要在 dispatcher 加 `Map<provider, Set<toolName>>` 之類的 cross-provider permission 狀態 — 看似 DRY，實際上強迫所有 provider 走最低公分母
- 不要為了「對稱」逼 Claude 不用 `updatedPermissions` 改自己存 Set — SDK 白送的不要不拿
- 不要把 SDK 的 `allowDangerouslySkipPermissions` 旗標當 bypass 入口 — 我們在 `canUseTool` 內 short-circuit 就好，不需要 SDK 安全鎖（也避免 user 認為「真的有開危險模式」）
- 不要把 `bypassPermissions` 邏輯放 renderer（auto-resolve permission_request 也算）— 每個 tool 多一次 IPC round-trip，純粹浪費；且分散後 audit/telemetry 難加


## 50. Per-project storage 統一在 `<userData>/projects/<id>/`

**決策**: 所有 per-project 的檔案產物都放在 `<userData>/projects/<projectId>/` 底下（PM project note、user-facing notes、note 圖片資料夾、未來新功能…）。Project 移除時 `removeProjectStorage(id)` 一行 `fs.rm` 整包清掉。

**原因**:
- 之前 PM note 自己一個 top-level `pm-notes/<id>.md` 目錄，且 project 移除時根本沒清——orphan 檔案累積
- 新功能（Notes, 之後可能有更多）每個都自選位置 = 每加一個就要記得改 removeProject 邏輯，必然會漏
- 改成統一目錄後，新加 per-project feature 只要寫進 `projectDir(id)`，移除是免費的
- ProjectId 不會跨 instance 共用，加上層 `projects/` 資料夾不會跟 sessionId-keyed 的東西（agent context）混

**配套**:
- `src/main/project-storage.ts` 提供 `projectDir(id)` / `ensureProjectDir(id)` / `removeProjectStorage(id)`
- `src/main/migrations/migrate-pm-notes.ts` 啟動時 idempotent 搬家：copy → verify → unlink，partial run 安全 resume
- `IPC.PROJECT_SAVE` handler 比較 old/new id set，刪掉的 id 觸發 `removeProjectStorage`

**不適用**:
- Agent context（`~/.shelf/agent-context/{sessionId}.json`）跟 IndexedDB agent UI history 是 sessionId-keyed 不是 projectId-keyed，多 session 共用一個 project，硬塞進來反而扭曲關係——維持現狀
- App-global 檔案（settings、pm-history、pm-global-note、ssh-servers、logs）不要動

**不要改**:
- 不要在新 per-project feature 自己 `<userData>/foo-<id>.md`，直接用 `projectDir(id)`
- 不要在 PROJECT_SAVE handler 之外另起 cleanup 路徑——單一進入點才不會漏


## 51. Notes 走 file storage + auto-GC，不用 base64 inline

**決策**: 使用者貼進 Notes panel 的圖片存成獨立檔案（`projects/<id>/images/<uuid>.<ext>`），markdown 引用 `![](images/<uuid>.png)`。每次 `writeNote` 掃 markdown 抓 ref，刪掉沒被 ref 的 image 檔。Renderer 透過 `shelf-image://<projectId>/<filename>` custom protocol 讀圖。

**原因**:
- Base64 inline 看似省事（刪文字 = 圖片自然消失，無生命週期），但 1MB 截圖→1.4MB 文字，5–10 張就讓 textarea / marked render 卡爆
- File + auto-GC 用 ~15 行 regex scan 達到「刪 ref → image 檔自動消失」一樣的體感，且 .md 維持純文字幾 KB
- `shelf-image://` 比 `file://` 更安全：在 main 端做 segment 驗證（拒絕 `..` / `/`），不暴露任意 file system 讀取

**配套**:
- `src/main/notes-store.ts` 的 `writeNote` 內呼叫 `garbageCollectImages` (regex `/images\/([\w.-]+)/g`)
- `src/main/notes-protocol.ts` 用 `protocol.handle()` (Electron 25+ 新 API)，scheme 在 `whenReady` 前 `registerSchemesAsPrivileged({ standard, secure, supportFetchAPI })`
- Renderer paste handler 抓 image MIME → IPC `notes:save-image` → 拿 ref 插入游標處
- Preview 渲染前用 regex rewrite `images/x` → `shelf-image://<id>/x`（marked 的 `![](images/x)` 跟 raw `<img src>` 兩種都處理）

**不要改**:
- 不要為了「不留垃圾」做嚴格 cleanup（每次 paste 都檢查全部 ref）— 太緊會誤刪正在編輯但還沒寫回的引用；目前 GC 只在 `writeNote` 觸發，跟磁碟 state 強同步
- 不要切到 base64「就一兩張小圖沒差」— 一旦 user 貼一張全螢幕截圖就崩，沒回頭路

---

## 52. Canonical `tool_use` 是 input/output 字串對，特殊渲染靠獨立 type 處理

**決策**: `AgentMessage` 的 `tool_use` variant 只攜帶 `{ toolUseId, toolName, input: string, result?: { content: string; isError? } }`。Renderer 永遠不看 toolName 也不解析 input — header 顯示 `toolName + input`（CSS 截斷處理超長），expand 後 body 只顯示 result，不重印 input。任何「這個 tool 需要特殊渲染」（例如檔案編輯顯示 diff、sub-agent 結果想 markdown render）的需求都應該升格成獨立 canonical type（已有 `file_edit`，未來可能 `tool_task`），**不要回到 tool_use 內部依 toolName 分流**。

**原因**:
- 早期 `tool_use` 帶 `toolInput: Record<string, unknown>`，renderer 用 `getToolSummary` + `ToolBody` 兩個 helper 各自 `switch (toolName)` 抽欄位 — Bash 抽 `command`、Read 抽 `file_path`、Copilot 是小寫 `bash` / `view` 又要寫第二組 case。每加一個新 SDK tool 要改 renderer 兩處，且 Copilot/Claude case-sensitivity 散落各地
- 重複顯示：header summary 跟 body 都從同一份 input 抽 `command` 字段，bash 卡片上 command 出現兩次
- Settings 也跟著 toolName-keyed（`Read`/`Bash`/`Edit`/`other`），Copilot 全部 fall back 到 `other`，等於同設定兩 provider 行為不同
- 重構後：provider 端 `formatClaudeToolInput()` / `formatCopilotToolInput()` 把 SDK 知識封裝在它該在的位置，renderer 變一條 switch + 截斷邏輯，settings 改 4 個 canonical type key（`thinking`/`tool_use`/`file_edit`/`intent`），新 provider 接進來 0 settings 改動

**配套**:
- Provider 寫 toolName→input string 的 mapping 表（Claude: Bash/Read/Grep/Glob/Task/Agent/WebFetch/WebSearch；Copilot: bash/view/grep/glob/list_directory/task；未知 fallback first string / JSON）
- `extractToolResultText()` 處理 Claude SDK content-block array `[{type:'text', text:'...'}]` → join string（Task/Agent sub-agent 標準返回格式）
- Persistence: 舊存的 `toolInput: object` 載入時 JSON-stringify 成 `input` 字串（`agent-history.ts:migrateLegacyToolUseInput`）
- 錯誤覆蓋：`result.isError === true` 強制展開 + 強制顯示（即使 settings 設 hidden 也照顯，silent failure 比 noisy 更糟）

**反例**:
- 把 markdown render 內嵌到 tool_use case（依 toolName 判斷要不要走 markdown）— 等於回到 toolName-sniff
- 把 `inputLabel` / `inputDetail` 拆兩欄位（必/選）— 截斷是 renderer CSS concern，不該 provider 決定
- 加 `category: 'shell' | 'read' | 'search' | 'other'` discriminator 在 tool_use 內 — 把分流隱藏在第二層

**不要改**:
- 不要在 renderer 加任何「if (toolName === ...)」分支
- 不要為了單一 tool（例如 Task）的渲染需求妥協 tool_use 設計 — 該升格 canonical type
- 不要把 `input` 改回 object — 那是 SDK terminology 漏進 canonical 層


## 53. Wire protocol envelope: per-event `turnId` for main-side turn routing

**問題**: 舊 `OutgoingMessage` 是 free-form `[key: string]: unknown`，沒有 envelope 標識「這個 event 屬於哪個 query turn」。`src/main/agent/remote.ts` 用單一 `lineHandler` setter 接收 stdout — 每個新 query 上來覆寫前一個的 handler。當 agent-server 在 turn N 結束後**延遲**發出 event（譬如 claude.ts `result` handler 發完 idle、`finally` block 又補一次），這個 leftover event 會被 turn N+1 剛裝好的 handler 吃掉，誤判成自己的 idle → for-await 立刻結束 → turn N+1 真實 events 沒人讀（queued msg bug 的根因）。

**決策**: 每個 per-turn wire event 帶 `turnId: string` envelope。

- Main 端在 `query()` 入口生成 turnId（`t-${randomUUID().slice(0, 8)}`），透過 IPC `send` payload 餵給 agent-server
- agent-server 的 `handleSend` 從 incoming msg 拿 turnId（缺則 fallback 新生），用 `wrapSendForTurn(turnId, send)` 包 send 函式 — 自動在所有 outgoing event 上 stamp turnId
- Provider 完全不感知 turnId（透過 closure 帶過去）
- Main 端的 `createTurnDispatcher`（`src/main/agent/turn-dispatcher.ts`）取代舊 `streamRemoteEvents`：單一全域 stdout listener 按 turnId 路由到 per-turn `AsyncGenerator`，turn 結束後 unregister；任何後續帶舊 turnId 的 event 找不到接收者就 log + drop
- Lifecycle events（`ready` / `pong` / `capabilities` / `credential_*`）在 turn 外部，turnId 是 optional — 由 requestId 或單一 dispatcher 處理

**為什麼這樣設計，而非 provider-side dedup**:

第一次修法（commit 0f3a1f8）走 provider 端：claude.ts query() 包 `dedupSend`，第一個 idle 過了就丟後續同類訊息。這只解了一個 race（idle 重發），同類問題（任何延遲/重發 event）會再踩。

Turn-id routing 從 protocol 層杜絕**整類 race**：跨 turn event leak 在語意上不可能發生（envelope mismatch 就 drop）。換來的成本：每個 event payload 多 ~12 bytes（`turnId: "t-xxxxxxxx"`）— 對 < 1000/turn 的 throughput 無感。

**Trade-off**:

- 寫起來：providers / canonical AgentMessage / WireEnvelope 都要明白「per-turn event 必帶 turnId」契約
- 讀起來：log 多一欄 turnId（但這也讓 debug cross-turn 場景更直觀）
- main-side dispatcher 內部複雜度小幅上升：Map<turnId, TurnState> 取代單一 closure — 但邏輯純，已被 `turn-dispatcher.test.ts` 9 case 覆蓋

**配套**:

- `OutgoingMessage` 從 `[key: string]: unknown` 收緊成 discriminated union（commit 5047c68）— 加 envelope 同時把整個 wire schema 講清楚，未來新 event 必須明確新增 variant
- `AgentMessage` / `stream` payload 多帶 `msgId`（commit 2fc4e44）— 不同於 turnId（per-turn）的另一層 envelope：per-message-block 識別碼，讓 stream chunks 跟 finalize 在 renderer-side 對齊到同一個 timeline entry
- Renderer 端 `streamText` / `streamThinking` 雙 state 拆除（commit 3e5b9e1）— 所有 stream + message 收進單一 `messages` 上 upsert，由 `msgId` 配對

**不要改**:

- 不要為了 backward-compat 加 fallback「沒 turnId 就分配給 currentTurn」— 這正是舊 single-lineHandler 模型的 bug 來源
- 不要在 provider 端 dedupe idle — Phase 1.3 後 turn-dispatcher 已從根上擋下，dedupSend 已拆除（commit 16e2bd7）
- 不要把 turnId / msgId 暴露給 renderer-side AgentMsg.id 以外的用法 — 它是 store 的 upsert key，不應該洩漏到 UI 行為決策（譬如「if id starts with t- 就...」）



## 54. Slash commands: provider-internal dispatch, not RPC channel

**問題**: 舊設計把 slash command 切成獨立的 `agent.slashCommand()` RPC channel：renderer 偵測 `/cmd` → 走 slash_command IPC → `handleSlashCommand` backend method → 回 `SlashResult` union（7 variants）→ renderer switch 7 個 case 各自渲染 UI。這條獨立路徑有四個老問題：

1. **Claude `/compact` 完成靜默** — `handleSlashCommand` 回 `pass-through`，SDK 內部處理；我們的 message pump 沒有 compact 完成事件可接，使用者按 enter 後一片寂靜。
2. **指令 echo 行為不一致** — `pass-through` 會 push user message，其他 case 不會。`/help` 結果像鬼飄出來，沒「我下了什麼指令」紀錄。
3. **架構錯位** — Claude SDK 早就會自己解釋 `/cmd` prefix（這就是 pass-through 的本意）。我們在 SDK 之上又外加一層 RPC channel，導致 Claude 必須 pass-through、Copilot 為了統一被迫自實作整套 slash，兩邊 mental model 不一致。
4. **加新 slash 要碰 renderer** — 每新增結果型態 renderer switch 就要 +1 case。違反 tool_use 已建立的「provider 自己處理，renderer 給框」原則。

**決策**: Slash 是 provider 想特別解釋的字串，不是獨立 channel。

- Renderer 不偵測 slash — `agent.send(text)` 一條路徑通吃普通 text 跟 `/cmd`
- Provider 在 `query(input, send)` 入口呼叫 `parseSlashPrefix(input.prompt)`，命中就走內部 `dispatchSlash(cmd, args, send)`
- Slash 輸出走 `slash_response` AgentMessage variant（pending → terminal status upsert，同 msgId）；複雜選擇互動走 `picker_request` 通道（generic N-way picker）；session/context side-effect 走 既有 `context_patch`
- Backend interface 只剩 `query(input, send)`，沒有 `handleSlashCommand`；wire protocol 上 `SlashResult` 整個 type 砍掉

**為什麼這樣設計**:

跟 tool_use 設計同哲學（#52）：renderer 給框，provider 給內容。Provider 內部成本不外部化 — 加新 model / 新 provider 不會把複雜度推到 renderer / IPC layer。Renderer 對「slash 是什麼」毫無概念，就像它對「Bash 是什麼」也沒概念一樣。

Lifecycle 對齊：slash 在外部觀察者眼中就是一個 turn（state machine：`running → stream events → idle`）。同樣的 `queuedMessages` queue 邏輯處理 streaming 期間的 slash，不需要插隊例外。

**為什麼 Claude `/compact` 完成回饋現在 work**:

SDK 原生提供 `SDKCompactBoundaryMessage`（subtype `compact_boundary`，帶 `pre_tokens` / `post_tokens` / `duration_ms`）跟 `SDKStatusMessage`（帶 `compact_result: 'success' | 'failed'`）。Claude provider 在 query() 偵測 `/compact` → 起手 emit `slash_response: pending "Compacting..."` → SDK 正常跑完 → for-await loop 攔截 `compact_boundary` 抓 metadata、`status` with `compact_result` 觸發 terminal emit。`critical()` helper 把這整段 turn 標為 non-stoppable，stop 按鈕靜默 ignore（avoid leaving SDK in half-compacted state）。

**Picker channel**:

`/model` 不能塞 slash_response（它要 N 選 1 互動，不是訊息）。新 `picker_request` / `picker_resolve` 通道從 permission_request 泛化來 — 同形狀（provider 邊有 pending Map，renderer 邊收 request → 顯示 SelectionPanel → resolve 回 provider）。`<SelectionPanel>` 元件同時服務 permission 跟 picker，視覺一致。

**Stop 行為**:

`stoppable` flag 是 provider-internal，不上 renderer。某些 slash 階段不可中斷（`/compact` 整個 SDK turn、`/clear` 的 dispose+rebuild 期間）— provider 用 `critical()` helper 包 critical section 期間 set false，stop() silently no-op。對齊業界（Cursor / Claude Code / Aider）— 「stop 按鈕永遠在，能不能停由 provider 決定」。

**不要改**:

- 不要把 SlashResult / slash_command 通道復活 — 那條路就是這次砍掉的對象
- 不要為了 fast-path 給 `/help` 開特例（不走 query()）— 統一 lifecycle 比省幾 ms 重要
- 不要把 slash 偵測搬到 orchestrator 或 main 端 — 違反「provider 自主決定要不要解釋 prefix」原則（未來 Claude 想加 `\help` 之類也行）
- 不要在 renderer 加「stoppable」UI 狀態 — 加了就回到 RPC 心智模型，違反 message stream 一致性

**配套**:

- `slash_response` AgentMessage variant（pending/success/error status carrier，content 是 provider 預格式化字串）
- `parseSlashPrefix` shared helper（agent-server/providers/slash-prefix.ts，可選用）
- IPC `AGENT_RESOLVE_PICKER` + outgoing `picker_request` event（generic N-way 互動）
- `<SelectionPanel>` 元件取代 permission popup + model picker 重複 JSX


## 55. Renderer-authoritative prefs + orchestrator-driven setX

**問題**: 三個進入點切 model 走三條路徑：

1. `/model X` slash → Copilot provider 內部 `applyModel` → emit capabilities
2. `/model` picker → 同 (1)
3. Status bar click → renderer `setStatusModel + setPrefs IPC + persistPref`

(1)(2) 是 backend → renderer，(3) 是 renderer → backend，方向相反。
Source of truth 散在兩邊（Copilot closure `currentModel` vs renderer `savedPrefs`），
靠 `onCapabilities` drift-back loop 強同步 — 不但複雜，還在 user 主動 picker
選 model 時把選擇撤回去（drift detect 認為 backend 漂走了 savedPrefs，推回去）。

而且 Copilot 的 closure `currentModel` 是 per-Provider 單例（`backends` Map
key 是 Provider，不是 sessionId），多 Copilot tab 共用同一 backend instance
等於互相覆蓋 model state — latent multi-tab bug。

**決策**: Renderer 是 prefs 唯一 source of truth；agent-server orchestrator
做 diff + 喊 setX。

- Renderer 每次 `agent.send` IPC payload 帶 `model` + `effort` +
  `permissionMode`（從 `savedPrefs` / `statusModel` 等讀），不再依賴 `setPrefs`
  IPC pre-load backend cache
- Agent-server `handleSend` 用 `lastAppliedPrefs: Map<sessionId, prefs>` diff
  detect — 跟上次套用的 prefs 比，差異才 call `backend.setModel?(value)` /
  `setEffort?` / `setPermissionMode?`
- Provider 的 setX 是**imperative**「apply this now」，不做 diff（orchestrator
  保證 only-on-change）。Copilot 實作會 call `state.session.setModel(...)`；
  Claude 不實作（per-call `options.model` 由 `sdkQuery` 直接用，不需要 setX）

**為什麼這樣設計**:

1. **持久化本來就是 renderer 工作**（`savedPrefs` in projectConfig）— prefs 順
   理成章是 renderer-owned
2. **單一 source of truth**：drift-back loop 砍掉（兩個 owner 互推的設計缺陷消失）
3. **Per-sessionId diff** 在 orchestrator → 多 tab 自然分離，沒 closure singleton
   覆蓋問題
4. **Claude / Copilot 不對稱優雅處理**：Claude 不實作 setX，optional
   `?.()` 自動 skip
5. **Provider 介面職責收斂**：query 跑 SDK / setX apply prefs，不再 inline 做
   「上次 X 是什麼」判斷

**配套：renderer-local config-edit slash**:

`/model` `/effort` `/permission` 不再是 agent command，是「快捷鍵版的 config
edit」（跟 status bar click 同義）。Renderer 在 `handleSend` 偵測
`RENDERER_LOCAL_SLASHES`（`model` / `effort` / `permission`→`permissionMode`
三條 alias map）就攔截 → call `handleConfigEdit` → persistPref + setStatus
state。零 IPC，下次 normal send 自然帶上新 pref。

`/model` 無參數 → renderer-local `<SelectionPanel>`（不走 picker_request channel，
那是給 provider-driven 互動預留）。Options 從 `capabilities.models` 拿（含 user
自訂 custom models — `mergeClaudeModels` 處理 SDK curated list + user 加的）。

**Validation 策略：SDK 是唯一仲裁者**:

不在 renderer 端驗 model 合法性。Capabilities.models 不是 authoritative（Claude
SDK `supportedModels()` 會隱藏 legacy models，但 SDK 實際接受）。`/model X`
直接 optimistic apply；SDK 拒絕時 orchestrator catch + emit `error` event，
文字包 `model` 名 + SDK 真實 error 訊息。No auto-revert — 使用者看到錯誤
自己再 `/model Y` 修。Hidden / legacy models 走 Settings 加 custom entry 的
既有路徑。

**不要改**:

- 不要把 prefs 放回 backend authoritative（drift-back loop 是這個設計的副作用）
- 不要在 renderer 加 model validation against capabilities — 我們不該替 SDK 扛
  curated list 維護責任
- 不要把 /model 放回 provider 的 SLASH_COMMANDS / CLAUDE_BUILTIN_COMMANDS —
  Provider 不該宣告它不處理的指令
- 不要在 provider 內 setX 做 diff — orchestrator 已經做了，重複 diff 沒意義

**配套變更**:

- `AGENT_SEND` payload 加 `model` / `effort` / `permissionMode`（step A）
- 加 `lastAppliedPrefs` Map + `applyPrefDiff` 到 agent-server orchestrator（step B）
- ServerBackend 加 optional `setModel?` / `setEffort?` / `setPermissionMode?`（step B）
- Copilot impl setX（step B），closure `currentModel` 等保留給 capabilities /
  ensureSession 用
- Claude 不 impl setX
- `AGENT_SET_PREFS` IPC、preload setPrefs、remote.ts 閉包 cache、`onCapabilities`
  drift-back 邏輯 — 全部砍（step C）
- `RENDERER_LOCAL_SLASHES` + `handleConfigEdit` + `localPicker` state（step D）
- `parseSlashPrefix` 從 agent-server 搬 `src/shared/` 共用（step D）
- /model 從 `CLAUDE_BUILTIN_COMMANDS` / `SLASH_COMMANDS` 移除（step E）
- Copilot `dispatchSlash` /model case 整段刪掉（step E）


## 56. Local shell HISTFILE=/dev/null：tab 間 history 完全隔離、不持久化

**決定**: `LocalUnixConnector.createShell()` spawn pty 時把 `HISTFILE=/dev/null` 塞進 env。每個 tab 的 shell process 只保留 in-memory history（↑↓ 在當前 session 內仍可叫回剛跑的指令），但不寫檔、不共享、關 tab 就沒。

**為什麼不直接用 user 的 `~/.zsh_history`**:
- Shelf 把 project 當 working context；多個 project 共用同一個 history file 會洩漏「我剛在哪個 project 跑了什麼」的狀態
- 多 tab 並開時，A tab 跑的指令污染 B tab 的 ↑（zsh `share_history` / inc_append 行為）
- 使用者實際 workflow：以 session 內微調指令重跑為主，少用 `history | grep xxx` 翻舊紀錄

**為什麼不寫 per-project history file**:
- 多一個檔案要管（mkdir、project 刪除 cleanup、備份範圍）
- 為了極少使用的 cross-session 翻舊紀錄需求增加架構複雜度，不值得
- 若之後有人需求，HISTFILE 從 `/dev/null` 改成 `userData/shell-history/<projectId>.history` 是一行改動，model 相容

**範圍**:
- Phase 1：只 `local/unix`（macOS / Linux 的 bash / zsh）
- Phase 2 候補：`local/win32` (PowerShell 用 PSReadLine，要 `Set-PSReadLineOption -HistorySavePath`)、`wsl`、`ssh`（遠端 history，要 ssh remote exec 注入，corner case 多）

**不要改**:
- 不要回到 `getShellEnv()` 直接傳（會繼承使用者 `HISTFILE` 設定）
- 不要 default 啟用持久化 — 沒有使用者訴求前先保持簡單


## 57. Picker_request 收編 AskUserQuestion / Elicitation 為多題互動 form

**問題**: Agent 主動發起的互動 prompt 有兩條真實 channel：
1. Claude SDK 的 `AskUserQuestion` tool — 1-4 題、per-題 N options、`multiSelect`、隱含 Other auto-add
2. Copilot SDK 的 `session.ui.confirm/select/input/elicitation` — JSON-Schema 形態的多 field form

Shelf-terminal 原本完全沒處理：Claude SDK 把 AskUserQuestion 當普通 tool_use 發出、`canUseTool` 沒攔；Copilot 沒 register elicitation handler。`/schedule` 之類仰賴 AskUserQuestion 的流程拿到空答案就卡住。

舊 `picker_request` 是 RPC channel 預留架構（single-question N-way pick，原本要服務 /model picker，後來 /model 走 renderer-local — DECISIONS #55），shipped 但無 producer。

**決策**: 重塑 picker_request 為「多題結構化 form」一統 channel：
- Wire shape：`prompts[]`（N 題）+ per-prompt `multiSelect` + `options[]` + 可選 `inputType: 'text' | 'number' | 'integer'`（設定後 renderer always-render 一個自填輸入框；AskUserQuestion 的隱含 Other auto-add 就靠這條映射過來）
- PickerResolvePayload：`{ answers: Array<string | string[]> }` index-aligned 或 `{ cancelled: true }`
- Claude provider：`canUseTool` 偵測 `toolName === 'AskUserQuestion'` 攔截、轉 picker_request、await renderer resolve、SDK output JSON 塞進 `{ behavior: 'deny', message: ... }` 餵回 model（spike 確認 model 解析 deny content 不看 is_error flag — `scripts/spike-askuser.ts`）
- Copilot provider：`registerElicitationHandler` 把 ElicitationSchema 7 field types → picker_request prompts（reverse mapping 含 integer/number parseInt/parseFloat fallback）

**為什麼不合併 permission_request 進 picker_request**:
- 字串 ownership 不同：permission 的 "Allow"/"Deny"/"Allow and remember" 是 app-owned 需要 i18n；picker question/option label 全是 agent-supplied 不能翻譯。合併會把 ownership 邊界從 channel level 退到 field-level discriminator，比一開始分兩個 type 還醜
- SDK 耦合：permission resolve shape (`{ behavior, message?, scope? }`) 跟 picker resolve shape (`{ answers }`) 不一樣，合併需要 adapter 互譯
- 「Allow + remember」是 permission domain 獨有的 3rd outcome，塞進 generic picker option 等於走私 side-effect
- 物理不會並存：兩條 channel 都走 canUseTool，SDK serialize tool calls，同 session 不可能同時 pending — DECISIONS #54 的「permission > picker」優先級規則對應「provider 主動 emit picker」假想場景，現實中不需要

**SDK 機制**:
- Claude 0.2.126 沒有 `onAskUserQuestion` callback，但 `canUseTool` 對所有 tool 觸發；deny 的 `message` 被 SDK 包成 tool_result content，model 解析 content 不看 is_error flag — spike 驗證
- Copilot SDK 有完整的 `registerElicitationHandler` API，handler 直接 return `{action: 'accept'|'cancel'|'decline', content?}`

**Out of scope v1**:
- Preview content 渲染（只 console.warn 收樣本，累積到 v2 決定 layout）
- `min/max/format/maxLength` 驗證（對齊 Claude CLI 行為 — 不驗，丟給 LLM 自己 re-prompt）
- Required field 區分（全部當必填）
- Copilot URL-mode elicitation（OAuth 外部 auth，decline + warn）
- `elicitationSource` 標示（UX 簡潔）

**不要改**:
- 不要把 permission 跟 picker channel 合併（i18n 邊界 + SDK adapter cost）
- 不要在 renderer 端 validate 數字 min/max（SDK 是仲裁者）
- 不要把 AskUserQuestion 加進 disallowedTools 退回純文字 — 我們已有 picker UI 跑完整流程

**配套變更**:
- `agent-server/providers/types.ts` — picker_request shape + PickerResolvePayload
- `agent-server/providers/claude.ts` — canUseTool 攔截 + askUserQuestionToPrompts / buildAskUserQuestionAnswerJson
- `agent-server/providers/copilot.ts` — registerElicitationHandler + elicitationSchemaToPrompts / picksToElicitationContent
- `src/main/agent/` 全層 + preload + env.d.ts — signature 同步
- `src/renderer/components/PickerPanel.tsx` — 新元件
- `scripts/spike-askuser.ts` — manual smoke regression（SDK 升級時跑一次驗 canUseTool deny+message hack 仍 work）
