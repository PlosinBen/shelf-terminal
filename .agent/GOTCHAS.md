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

## 5. SSH SCP mkdir 失敗不會中止

**現象**: SCP image 到遠端時，如果 `/tmp/shelf-paste/` 不存在，`mkdir` SSH 指令可能失敗。

**原因**: `clipboard-image.ts` 的 mkdir callback 不管成功失敗都繼續 SCP（因為目錄可能已存在）。

**注意**: 如果遠端禁止建立 `/tmp/shelf-paste/`，SCP 會失敗但不會有明確錯誤回饋給用戶。

---

## 6. Image Paste 只攔截純圖片剪貼簿

**現象**: 複製含文字的網頁截圖時，圖片貼上功能沒反應。

**原因**: `handlePaste` 檢查 `hasText`（clipboard 有 text/plain item），有文字就 return 讓 xterm 處理正常貼上。

**注意**: 這是 intentional — 避免用戶貼文字時被圖片處理攔截。只有 screenshot（純圖片）才會觸發。

---

## 7. Idle Notification 的 5 秒最小門檻

**現象**: 快速指令（如 `ls`）不會觸發通知。

**原因**: `MIN_ACTIVE_MS = 5000` — pty output 必須持續 5 秒以上才算「長時間指令」。3 秒無 output 後才檢查。

**注意**: 這是 intentional — 避免每個 `ls`、`cd` 都跳通知。

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

**原因**: 三種 connector（local/SSH/WSL）走同一條 spawn 路徑，問題出在 App.tsx event handler 和 TerminalView 重複 spawn，不是 WSL 特有。

**注意**: Connector 統一介面後，spawn/connect/disconnect 等行為在 local 上就能驗證。不需要等特定平台測試。修 bug 前先在 local 用 log 確認。
