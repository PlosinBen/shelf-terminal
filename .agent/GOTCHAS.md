# GOTCHAS — Non-obvious Behaviors & Past Issues

## 1. DEFAULT_SETTINGS 不能放在 types.ts

**現象**: Renderer 啟動時報 `settings is not defined`，白屏。

**原因**: `types.ts` 通常只有 type export，vite 在 production build 時可能對 runtime value export 處理不一致。`DEFAULT_SETTINGS` 放在 `types.ts` 裡，store.ts import 它時在 bundle 中變成 undefined。

**解法**: Runtime value 獨立放在 `shared/defaults.ts`，type 留在 `types.ts`。

---

## 2. App.tsx 解構 useStore() 必須包含所有使用的欄位

**現象**: `settings is not defined` ReferenceError，app 白屏。

**原因**: `const { projects, activeProjectIndex, sidebarVisible } = useStore()` 漏了 `settings`，但後面直接用 `settings.themeName`。在 minified bundle 中變成未宣告的變數。

**解法**: 確保 `useStore()` 解構包含所有後續使用的欄位。

---

## 3. node-pty 需要 electron-rebuild

**現象**: `pty.spawn` 報 `posix_spawnp failed` 或 native module 版本不符。

**原因**: node-pty 是 native module，npm install 時編譯的是 Node.js 版本，不是 Electron 的 Node。

**解法**: `postinstall: electron-rebuild`，CI 上需要 Python + setuptools for node-gyp。

---

## 4. WSL 雙重 Prompt

**現象**: WSL 連線後 terminal 顯示兩次 `user@host:~$`。

**原因**: `wsl.exe --cd /path` 啟動時 shell profile 載入一次印 prompt，然後 login shell 又印一次。

**解法**: 改用 `wsl.exe -d distro -- bash -l -c "cd /path && exec $SHELL -l"`，只有一個 login shell。

---

## 5. 檔案上傳 mkdir + cat 串在同一個 sh -c

**現象**: 在 `file-transfer.ts` 把 `mkdir -p` 和 `cat >` 拆成兩次 ssh / docker exec 呼叫時，有時候 race 到 cat 看不到目錄。

**解法**: 一律用 `sh -c "mkdir -p '<dir>' && cat > '<path>'"`，目錄建立和寫入在同一個遠端 shell 內順序執行。`mkdir -p` 本身就 idempotent，目錄已存在不會錯。

**注意**: 路徑用 `shellSingleQuote` 包起來，遠端 shell 不會二次解析任何字元；若改回呼叫 `execFile` 走 scp/docker cp，就要重新處理跨 shell 的 quoting。

---

## 6. Paste 使用 Capture Phase 攔截，Drop 使用 Bubble Phase

**現象**: 檔案 paste 沒反應。

**原因**: xterm 的 `xterm-helper-textarea` 攔截 paste event 後不會冒泡到 container。必須用 capture phase（`addEventListener` 第三參數 `true`）在 xterm 之前攔截。Drop 不需要 capture phase 因為 xterm 不攔截 drop 事件。

**判斷邏輯**:
- Paste：clipboard 含有 `kind === 'file'` 的 item 就走上傳；若同時帶 `text/html`（從瀏覽器複製富文本，image 只是 favicon）則放行讓 xterm 當文字貼上。
- Drop：`dataTransfer.files` 非空就走上傳，不檢查 MIME（任何檔案都收）。

---

## 7. Idle Notification 需要使用者輸入 + 5 秒門檻

**現象**: 快速指令（如 `ls`）或 agent CLI（Claude Code、Copilot）的背景輸出不會觸發通知。

**原因**: 兩個條件都要滿足：(1) `userInput = true` — 只有使用者透過鍵盤輸入（`writePty`）才標記，agent 自行產生的 pty output 不算。(2) `MIN_ACTIVE_MS = 5000` — output 必須持續 5 秒以上。

**注意**: 這是 intentional — 避免 agent CLI 背景輸出不斷觸發通知。

---

## 8. electron-builder CI 需要 top-level permissions

**現象**: GitHub Actions build 報 `403 Forbidden`。

**原因**: electron-builder 在 build 時自動嘗試 publish 到 GitHub Release，需要 `contents: write` 權限。如果權限只在 release job 而非 build job，會被拒絕。

**解法**: workflow 頂層設 `permissions: contents: write`，讓 electron-builder 直接 publish。

---

## 9. Linux deb 打包需要 author email

**現象**: CI Linux build 報 `Please specify author 'email'`。

**原因**: electron-builder 打 `.deb` 時需要 maintainer email，從 `package.json` 的 `author` 欄位讀取。

**解法**: `package.json` 的 `author` 必須包含 email：`"PlosinBen <plosinben@gmail.com>"`。

---

## 10. vite build cache 可能不反映檔案搬移

**現象**: 把 `DEFAULT_SETTINGS` 從 `types.ts` 搬到 `defaults.ts` 後，build 產出的 hash 沒變，問題依舊。

**原因**: vite 的 build cache 認為內容沒變（只是 import source 不同）。

**解法**: `rm -rf dist` 強制清除再 build。

---

## 11. Playwright E2E 共用 worker scope

**現象**: 測試之間的 state 互相影響（例如一個測試建了 project，後面的測試看到多個 project）。

**原因**: `shelfApp` fixture 是 `scope: 'worker'`，同一個 worker 的所有 spec file 共用同一個 Electron instance。

**注意**: 斷言不要用精確的 count（如 `toHaveCount(1)`），改用 `toBeGreaterThanOrEqual(1)` 或 `.first()`。

---

## 12. autoHideMenuBar 只影響 Windows

**現象**: macOS 上設 `autoHideMenuBar: true` 沒效果。

**原因**: macOS 的 menu bar 在螢幕頂部（系統層級），不在視窗內。`autoHideMenuBar` 只影響 Windows/Linux 的視窗內 menu bar。

**注意**: 這是正常行為，不是 bug。

---

## 13. Connector 問題可用 Local 重現

**現象**: WSL 雙重 prompt 問題，看似只能在 Windows 測試。

**原因**: 所有 connector 都透過 `createConnector()` factory 走統一的 `Connector` 介面（`createShell`、`listDir`、`uploadFile` 等），spawn 邏輯集中在 `pty-manager.ts` 的 `connector.createShell(cwd)`。問題通常不是特定 connection type 造成的。

**注意**: Connector 統一介面後，spawn/connect/disconnect 等行為在 local 上就能驗證。不需要等特定平台測試。修 bug 前先在 local 用 log 確認。

---

## 14. TerminalView 的 paste/drop handler 是 closure，settings 要走 ref

**現象**: 改了 Settings 的 Max Upload Size 後，已經開著的 tab 還是用舊的上限。

**原因**: paste/drop listener 在 `useEffect([tabId])` 裡綁一次就不再重綁，閉包抓的是 mount 當下的 `settings.maxUploadSizeMB`。

**解法**: `TerminalView` 用 `maxUploadMBRef = useRef(settings.maxUploadSizeMB)` 並在每次 render 同步 `.current`，handler 內讀 `.current` 而非閉包變數。`connection` 與 `cwd` 不會在 tab 生命週期內變動，仍然走閉包即可。

---

## 15. npm sudo 會污染 ~/.npm 導致後續 install EACCES

**現象**: `npm install vitest` 報 `EACCES: permission denied` 寫 `~/.npm/_cacache`，但 `~/.nvm/...` 的 node_modules 是使用者擁有的。

**原因**: 過去用過 `sudo npm install -g <pkg>` → npm 在 `~/.npm/_cacache` / `~/.npm/_logs` 留下 root-owned 檔，之後非 sudo 的 npm 寫不進去。

**解法**:
1. 確認 root prefix：`npm root -g` 應該指向 nvm 路徑（使用者擁有），不要回 `/usr/local/lib/node_modules`。
2. 把曾經 sudo 裝過的 global package 重新非 sudo 安裝：先 `sudo npm uninstall -g <pkg...>`、再 `sudo rm -rf ~/.npm/_cacache`、最後 `npm install -g <pkg...>`。
3. AI CLI tool 的 session（Claude Code、Copilot、Gemini 等）放在 `~/.copilot/` / `~/.claude/` / `~/.gemini/` 等獨立目錄，npm uninstall 不會碰。

**規則**: 即使是全域 CLI 工具也用 `npm install -g`，**永遠不要 `sudo npm`**。

---

## 16. parseUploadPrefix 必須卡長度 + 時間範圍，不然會誤刪使用者檔

**現象**: Session cleanup 把使用者自己丟進 `.tmp/shelf/` 的檔（例如 `manually-placed.log`）也刪掉了。

**原因**: 早期版本的 `parseUploadPrefix()` 只檢查「是不是 `[a-z0-9]+-...`」就接受。`manuall`（取 prefix 去掉最後一個 counter char）剛好是合法 base36，`parseInt('manuall', 36)` ≈ 48 億 ms，遠小於現在的 `Date.now()`，於是被歸類為 stale 然後刪掉。

**解法**: 在 `file-transfer.ts` 的 parser 裡同時要求：
1. `prefix.length >= 9` — 真實的 Shelf prefix 是 8 字元 base36 timestamp + 1 counter char，1972~2059 都是 9 字元。
2. 解出來的 ms 落在 `[2020-01-01, 2100-01-01)` 這個 sanity window。

**注意**: 第二個 floor 同時擋掉「9 字元但解出來變 1995」的字（例如 `aaaaaaaaa`）。如果以後要改 prefix 格式，這兩個 guard 都要同步調整，並補上 regression test（`file-transfer.test.ts` 已經有 `manually-placed.log` 跟 `aaaaaaaaa` 兩個 case）。

---

## 17. macOS 自動更新需要 code signing

**現象**: macOS 上 electron-updater 檢查到新版但無法安裝更新。

**原因**: `.github/workflows/build.yml` 設了 `CSC_IDENTITY_AUTO_DISCOVERY: false`，CI build 出來的 macOS binary 沒有簽名。electron-updater 在 macOS 上使用 Squirrel.Mac，要求更新包必須經過 code signing 才能安裝。

**解法**: 需要 Apple Developer ID certificate（Apple Developer Program, $99/年），然後：
1. 匯出 `.p12` 憑證，base64 encode 存到 GitHub Secrets（`CSC_LINK` + `CSC_KEY_PASSWORD`）
2. 移除或改掉 `CSC_IDENTITY_AUTO_DISCOVERY: false`
3. 可能還需要 notarization（macOS 10.15+ 要求）

**注意**: Windows 不需要 code signing 就能自動更新。在沒有 Apple 憑證之前，macOS 用戶只能手動下載新版。

---

## 18. App 快捷鍵 Capture Phase + stopPropagation

**現象**: 快捷鍵（如 ⌘D、Ctrl+D）在 terminal 有 focus 時沒反應，或同時觸發 terminal 行為。

**原因**: xterm.js 在自己的 keydown handler 裡處理鍵盤事件，比 bubble phase 更早。

**解法**: `useKeybindings` 在 window capture phase 攔截，匹配到 app 快捷鍵後 `stopPropagation`，xterm 完全收不到。新增快捷鍵只需在 types + defaults + useKeybindings 註冊。見 Decision #18。

---

## 19. Windows Ctrl+V/C 需要 Custom Key Event Handler

**現象**: Windows/Linux 上 Ctrl+V 貼上、Ctrl+C 複製無效。

**原因**: xterm.js 預設把 Ctrl+V 當作 `\x16`、Ctrl+C 當作 `\x03` 送進 pty。這兩個不是 app 快捷鍵（不在 useKeybindings 裡），所以 capture phase 不會攔截它們。macOS 用 Cmd+V/C 不受影響。

**解法**: 在 TerminalView 用 `term.attachCustomKeyEventHandler()` 對非 Mac 平台攔截 Ctrl+V 和 Ctrl+C（有選取時），return `false` 讓瀏覽器處理。

---

## 20. Tab Mute 狀態不持久化

**現象**: 重啟 app 後 tab 的 mute 狀態消失。

**原因**: mute 狀態只存在 main process 的 `mutedTabs` Set 中，沒有寫入 settings 或 projects.json。

**注意**: 這是 v0.2.4 的設計——僅 runtime mute，重啟重置。如果未來要持久化需另外實作。

---

## 21. project-store 有臨時的 audit log（v1.0.0 前移除）

**現象**: `~/Library/Application Support/shelf-terminal/project-audit.log` 會持續累積 LOAD / SAVE / SAVE_BACKUP 記錄，且 **不受 `logLevel` 控制**。

**原因**: v0.5.0 之後出現 `projects.json` 被寫成 `[]` 的資料遺失事件。為了未來 debug 同類事件、又不想逼使用者把 `logLevel` 調到 `info`，在 `src/main/audit-log.ts` 開了一個繞過 logger 的 append-only 檔。觸發點在 `project-store.ts` 的 `loadProjects` / `saveProjects` / `maybeBackupBeforeEmptyWrite`。

**v1.0.0 時要做**:
1. 刪除 `src/main/audit-log.ts` 與所有 `appendAudit(...)` 呼叫
2. 如果仍要保留 load/save 可觀測性，改用正常 `log.info('project-store', ...)`，尊重使用者 `logLevel` 設定
3. `src/main/index.ts` 的 `LOGS_CLEAR` handler 移除 `clearAudit()` 呼叫
4. 同步移除這條 gotcha

---

## 22. xterm.js open() 只能呼叫一次，remount 要移動 DOM

**現象**: 拖曳排序 project 後 terminal 變黑屏。

**原因**: React 在 `projects.map()` 順序改變時會 unmount/remount TerminalView。remount 時 `initializedRef` 重置為 false，導致 `term.open(newContainer)` 被第二次呼叫。xterm.js 不支援 `open()` 重複呼叫，terminal 進入壞狀態。

**解法**: 在 `terminalCache` 加 `opened: boolean` flag。首次 mount 正常呼叫 `term.open(container)`；remount 時改用 `container.appendChild(term.element)` 把已有的 DOM 搬過去，不呼叫 `open()`。搬移後重新載入 WebglAddon（canvas 移動可能觸發 context loss）。

**注意**: WebGL context loss 的 handler 也要自動 reload addon（`dispose()` + `setTimeout(() => loadWebgl(term), 100)`），否則會 fallback 到 DOM renderer 導致畫面異常。

---

## 23. Unicode11Addon 導致 tab completion 字元重複

**現象**: 在 terminal 輸入任意字元後按 Tab 觸發 shell autocomplete 列表時，已輸入的字元會重複顯示（如輸入 `ca` 顯示 `caca`）。實際送進 shell 的指令是正確的，只是顯示問題。

**原因**: xterm.js Unicode11Addon 把 Ambiguous width 字元（如 prompt 中的 `→` U+2192）當 width 1，但 zsh 可能當 width 2。Tab completion 時 shell 根據自己的寬度計算重繪命令行，游標位置與 xterm 不同步，導致字元偏移重複。這是 xterm.js 的已知限制（[#1453](https://github.com/xtermjs/xterm.js/issues/1453)、[#4753](https://github.com/xtermjs/xterm.js/issues/4753)）。

**解法**: Unicode11Addon 仍然載入（註冊可用版本），但預設不啟用（`unicode.activeVersion` 保持預設 `'6'`）。使用者可在 Settings 開啟「Unicode 11」選項，啟用後即時生效。

**注意**: 啟用 Unicode 11 可改善較新 emoji 和部分 CJK 字元的寬度判定，但只要 prompt 含有 Ambiguous width 字元就可能觸發此問題。

---

## 24. Agent store 要 immutable update 否則 React 不 re-render

**現象**: Copilot tab 送訊息後訊息進了 store 但 UI 不更新，要在 textarea 打字才跳出來。

**原因**: 早期 `updateAgentState()` / `addAgentMessage()` 用 `Object.assign(state, ...)` / `state.messages = [...]` 原地改同一個 object。`useSyncExternalStore` 用 `Object.is` 比對 snapshot，同 reference → 跳過 re-render。Claude tab 不明顯因為事件密集會連帶觸發其他 state 變化；Copilot 純 chat 流沒有旁的 state 變化就露餡。

**解法**: `store.ts` 的 mutator 一律 `agentStates.set(tabId, { ...state, ...partial })` — 每次 emit 都產生新 snapshot reference。

**注意**: 之後新增任何 agent state field / mutator 都要守住 immutable 約定，否則會復發。

---

## 25. Copilot session token 的 `Editor-Plugin-Version` 白名單

**現象**: 讀對 GitHub token 但 `/copilot_internal/v2/token` 回 404。

**原因**: GitHub 對 `Editor-Plugin-Version` header 有白名單，自定的 `shelf-terminal/1.0` 會被拒。且 `gh auth token` 預設 scope 沒有 `copilot`，亦會 404。

**解法**:
- Header 用 `github-copilot-cli/1.0.5`（或 `copilot-chat/x.y.z`、`copilot.vim/x.y.z`）— 見 `src/main/agent/auth/copilot-auth.ts`
- `gh` token 需使用者先跑 `gh auth refresh -h github.com -s copilot` 補 scope
- 我們優先讀 `~/.config/github-copilot/apps.json`（neovim copilot.vim / copilot-cli 寫的 token，scope 正確）

**注意**: OpenAI 或 Copilot 更新 UA 白名單時要同步更新 `EDITOR_VERSION` / `EDITOR_PLUGIN_VERSION` 常數。

---

## 26. `reasoning_effort` model 偵測靠 pattern match

**現象**: 送 `reasoning_effort` 給不支援的 model（如 gpt-4o）API 會 400。

**原因**: OpenAI 沒提供「哪個 model 吃 reasoning_effort」的 API signal。只能靠 model id 家族推論。

**解法**: `tools/registry.ts` 的 `getEffortLevels(modelId)` — `^o\d` → 三檔、`^gpt-5(?!-chat)` → 加 `minimal`。Copilot warmup 時為每個 model 填 effortLevels，processor 在 request 時只對有 levels 的 model 帶參數。

**注意**: OpenAI 公告新 reasoning model 家族（o5、gpt-6 等）時要手動更新 pattern，否則該 model 的 effort chip 會隱藏。詳見 `.agent/features/AGENT_SDK_INTEGRATION.md` 的 Reasoning Effort 偵測小節。

---

## 27. Credentials 存在「使用中那台機器」的 `~/.config/shelf/`，不是 userData

**現象**: 在本機 app 設 Gemini API key，SSH 到遠端跑 Gemini 居然還是問要 key。

**原因**: v0.8 Credential Store 設計是 **per-machine** — `createStaticCredentialStore()` 永遠解析成「當前 process 的 `~/.config/shelf/{id}.json`」。本機 backend 寫到本機家目錄；remote backend 跑在 agent-server 內，寫到遠端家目錄。credentials **不會**透過網路傳遞。

**為何這樣**:
1. 安全：API key 不會在 main process 與遠端 server 間以明文流動，也不會落地在本機 userData。
2. 一致性：跟 aws cli / gh / npm 的行為對齊——同台機器的 shelf 跟 terminal CLI 共用同一份 key（env var 也能直接蓋過）。
3. 邊界清楚：登出一台機器不會意外登出另一台。

**讀取順序**: env var (`GEMINI_API_KEY` 等) → `~/.config/shelf/{id}.json`。env var 是 runtime override，**不會**被寫回檔案。

**注意**: 未來若要做「本機一份、多台共用」的混合模式（本機 key forward 作為遠端 fallback），要明顯走 opt-in 旗標，不要預設行為。目前 `Optimize.md` 記為 v0.9 候選。

---

## 28. Agent backend 是 method-per-capability，不要退回 blob capabilities

**現象**: 很想寫 `if (caps.slashCommands) { ... }` 來做一個 provider 獨有的分支。

**原因**: 早期 `ProviderCapabilities` 是單一 blob，scheduler 要根據旗標決定打哪條路徑；v0.8 把每個能力拆成 optional method（`getModels` / `getSlashCommands` / `storeCredential` / `clearCredential` / `getAuthMethod` / `getCapabilities`...）。差異封裝在 provider 內部，外層流程統一。

**規則**:
- 外層（`src/main/agent/index.ts`）只呼叫 method，從不檢查 provider 名稱。
- 不支援某能力的 provider 就不 expose 那個 method。scheduler 先 `typeof backend.getX === 'function'` 再呼叫。
- Remote backend (`remote.ts`) 一律 expose 全部 method，內部靠 `oneShotRequest` 轉發到 agent-server；agent-server 端再 fall-through 到各 provider。

**注意**: 加新能力時不要把它塞進既有的 `ProviderCapabilities` blob——開新 method、更新 `AgentBackend` interface、remote 端加 request/response kind、agent-server 加 handler。詳見 `.agent/features/AGENT_SDK_INTEGRATION.md` 的 Method-per-Capability 小節。

---

## 29. Agent-server 透過 stdin/stdout 做雙向 request，用 `oneShotRequest` 包

**現象**: 想加個遠端呼叫（如 `storeCredential`），在 `remote.ts` 要處理 request-id 配對、timeout、永遠 resolve 等細節。

**解法**: 用 `oneShotRequest(kind, payload)` helper — 它會：
1. 生成唯一 requestId 塞進 outgoing message。
2. 註冊一個 resolver 到 pending map。
3. 等 agent-server 回對應 requestId 的 response 或 error。
4. 超時/dispose 自動 reject 並清 map，不洩漏 handler。

Agent-server 端的 permission 流（`canUseTool` 把 SDK 的 permission 請求透過 `send({ type: 'permission_request', toolUseId, ... })` 發回 main，等 main 回 `resolve_permission`）同樣 pattern，不過 key 是 `toolUseId` 而非 requestId。兩個 map 不共用。

**注意**: 新增跨程序的 one-shot 行為（get capabilities、store credential、clear credential、check auth...）都走 `oneShotRequest`；不要 ad-hoc 做 event listener。
