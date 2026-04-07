# Shelf Terminal — Task List

## v1 MVP — ✅ Done (commit 59c0206)

Tasks 1–13 完成，含 E2E 測試（10 tests passing）。

---

## v2 Tasks

### 14. Remote 連線（SSH / WSL）
- **狀態**: pending
- **說明**: 支援 SSH（`pty.spawn('ssh', [ControlMaster 參數, user@host])`）和 WSL（`pty.spawn('wsl.exe', ['-d', distro])`）。新建 project 時選擇連線方式，FolderPicker 列出遠端目錄。SSH 使用 ControlMaster multiplexing，同 project 多個 tab 共用 TCP 連線。

### 15. 圖片貼上 — Remote 支援
- **狀態**: pending
- **依賴**: #13, #14
- **說明**: SSH session 中貼上圖片時，透過 SCP/SFTP 傳到遠端 temp 目錄，貼上遠端路徑。從 ProjectConfig.connection 判斷是否為 SSH session。

### 16. 分割畫面
- **狀態**: pending
- **說明**: 如需要，支援 terminal 分割顯示。

### 17. Tab 命名 / 拖曳排序
- **狀態**: pending
- **說明**: 允許自訂 tab 名稱、拖曳調整 tab 順序。

### 18. Terminal 主題自訂
- **狀態**: pending
- **說明**: 支援 xterm.js 主題、字型等外觀設定。

### 19. xterm.js 問題修正
- **狀態**: pending
- **說明**: 修正中文輸入、貼上等已知 xterm.js 相容性問題。

### 20. App 設定系統
- **狀態**: pending
- **說明**: 全域設定存到 ~/.config/shelf-terminal/settings.json（scrollback、主題、字型等），啟動時載入，變更時即時套用 + 寫入。
