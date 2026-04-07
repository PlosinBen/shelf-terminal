# Shelf Terminal — MVP Task List

## 依賴關係

```
#1 專案初始化
├── #2 IPC type definitions
├── #4 Project 持久化
├── #6 Layout 骨架
│   ├── #7 Sidebar
│   ├── #8 Tab bar
│   ├── #11 快捷鍵系統
│   └── #10 FolderPicker 元件 (← #5)
├── #3 pty 管理 (← #2)
├── #5 FolderPicker 目錄列表 (← #2)
└── #9 xterm.js terminal view (← #2, #3, #6)
    ├── #12 App 重啟恢復 (← #3, #4, #9)
    └── #13 圖片貼上功能
```

## Tasks

### 1. 專案初始化
- **狀態**: pending
- **依賴**: 無
- **說明**: 建立 shelf-terminal repo、package.json、TypeScript 設定、Electron + Vite + React 基礎結構（src/main、src/renderer、src/shared）

### 2. IPC type definitions
- **狀態**: pending
- **依賴**: #1
- **說明**: 在 src/shared 定義 Electron IPC channel types（pty:spawn、pty:input、pty:resize、pty:kill、pty:data、pty:exit、folder:list 等）

### 3. Main process — pty 管理
- **狀態**: pending
- **依賴**: #1, #2
- **說明**: 實作 node-pty 管理：spawn shell、接收 input、resize、kill。管理多個 project 的多個 tab 對應的 pty instances。

### 4. Main process — project 持久化
- **狀態**: pending
- **依賴**: #1
- **說明**: ProjectConfig 存取 ~/.config/shelf-terminal/projects.json，包含 id、name、cwd、connection、maxTabs。App 啟動時載入，變更時寫入。

### 5. Main process — FolderPicker 目錄列表
- **狀態**: pending
- **依賴**: #1, #2
- **說明**: 透過 IPC 提供目錄列表功能，renderer 請求路徑 → main 回傳該路徑下的資料夾/檔案列表。支援 ~ 展開、dot-files 排序。

### 6. Renderer — Layout 骨架
- **狀態**: pending
- **依賴**: #1
- **說明**: 實作基本 layout：左側 sidebar（project list）、右側上方 tab bar、右側主區 terminal view。支援 sidebar 顯示/隱藏。

### 7. Renderer — Sidebar（project list）
- **狀態**: pending
- **依賴**: #6
- **說明**: 顯示 project 列表，每個 project 顯示名稱和狀態燈號（green=有 pty alive、grey=無）。支援選擇切換 active project。

### 8. Renderer — Tab bar
- **狀態**: pending
- **依賴**: #6
- **說明**: 顯示當前 project 的 terminal tabs，支援切換 active tab、新增 tab、關閉 tab。

### 9. Renderer — xterm.js terminal view
- **狀態**: pending
- **依賴**: #2, #3, #6
- **說明**: 每個 tab 各自一個 xterm.js instance，透過 IPC 接收 pty:data 顯示輸出、發送 pty:input 傳遞鍵盤輸入。切換 tab 以 CSS 隱藏/顯示。處理 resize 事件。

### 10. Renderer — FolderPicker 元件
- **狀態**: pending
- **依賴**: #5, #6
- **說明**: 自製目錄瀏覽器 UI，透過 IPC 請求目錄列表，讓使用者選擇 project 資料夾。dot-files 排在後面。

### 11. 快捷鍵系統
- **狀態**: pending
- **依賴**: #6
- **說明**: 實作快捷鍵：mod+B 切換 sidebar、mod+O 新建 project、mod+W 關閉 project、mod+↑↓ 切換 project、mod+shift+[/] 切換 tab、mod+T 新建 tab。可自訂，持久化到 localStorage。

### 12. App 重啟恢復
- **狀態**: pending
- **依賴**: #3, #4, #9
- **說明**: App 啟動時載入 projects.json，恢復 project 列表，每個 project 自動開一個 fresh shell tab（cwd 為 project.cwd）。

### 13. 圖片貼上功能
- **狀態**: pending
- **依賴**: #9
- **說明**: 攔截 paste 事件，偵測 clipboard 中的圖片 → 存到 /tmp/shelf-paste/ → 將路徑貼入 terminal。清理策略：定時清除過期檔案 + App 關閉時清除整個目錄。

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
