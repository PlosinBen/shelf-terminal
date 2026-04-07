# PRD: Shelf Terminal

> **Shelf** — 跨平台、project-based 的 terminal manager，取代 tmux 的多專案管理體驗。
>
> - App 名稱：**Shelf**
> - Repo 名稱：`shelf-terminal`

## 問題

1. 多個專案同時跑 CLI tool（claude、gemini 等），tmux 切換體驗差
2. Mac 和 Windows 兩台機器，快捷鍵和操作方式不統一
3. tmux 分割畫面時複製文字會跨區
4. 透過 SDK 串接 AI agent 有 token 消耗高和政策風險的問題

## 產品定位

**跨平台、project-based 的 terminal manager。**

不自己做 agent UI，不串接任何 AI SDK。每個 terminal 就是一個真正的 terminal，使用者自己決定要跑什麼。

## 技術架構

```
Electron main process
  ├── node-pty（管理多個 pty process）
  ├── Project persistence（JSON）
  └── IPC
        ↕
Electron renderer
  ├── xterm.js（terminal 顯示）
  ├── Sidebar（project 列表）
  ├── Tab bar（per-project terminal tabs）
  └── Keybindings
```

單一 Electron app，不需要獨立的 server process。
Main process 直接管理 pty，透過 Electron IPC 與 renderer 通訊。
Remote 連線透過 SSH 處理（`pty.spawn('ssh', [...])`），不另做 remote server protocol。

### 專案結構

```
shelf-terminal/
├── src/
│   ├── main/          # Electron main process + node-pty 管理
│   ├── renderer/      # React + xterm.js
│   └── shared/        # IPC type definitions
├── package.json
```

不使用 monorepo，單一 package。

## 核心功能（MVP — Local only）

### Project 管理

- 左側 sidebar 顯示 project 列表
- 每個 project 綁定一個本機資料夾路徑
- 新建 project：自製 FolderPicker 選擇資料夾 → 自動開一個 terminal tab
- FolderPicker 透過 IPC 列出目錄，不用 native dialog（未來 SSH 時可無痛切換為列出遠端目錄）
- Project 設定持久化到本機（`~/.config/shelf-terminal/projects.json`）
- App 重啟時：恢復 project 列表，每個 project 自動開一個新 terminal tab（fresh shell）

### Terminal Tab

- 每個 project 可開多個 terminal tab（上限預設 5 個，可設定）
- 每個 tab 對應一個獨立的 pty process（spawn `$SHELL`）
- 每個 tab 各自一個 xterm.js instance，切換 tab 以 CSS 隱藏/顯示（保留 scroll buffer，切換瞬間完成）
- 新增 tab：開一個新的 shell，cwd 為 project 路徑
- 關閉 tab：kill pty process
- Tab 不做重建 — app 重啟後只恢復 project 列表，不恢復 tab 狀態（每個 project 開一個 fresh shell）

### Layout

- 左側：project list（sidebar）
- 右側上方：tab bar
- 右側主區：terminal view（xterm.js，全區域顯示當前 tab）
- 不做分割畫面（避免 tmux 的複製跨區問題）

### 快捷鍵

| 動作 | 預設綁定 | 說明 |
|------|---------|------|
| 切換 sidebar | `mod+B` | 顯示/隱藏左側 project list |
| 新建 project | `mod+O` | 開啟資料夾選擇器 |
| 關閉 project | `mod+W` | 關閉當前 project（kill 所有 pty） |
| 上一個 project | `mod+↑` | sidebar 中往上切 |
| 下一個 project | `mod+↓` | sidebar 中往下切 |
| 上一個 tab | `mod+shift+[` | 同 project 內切 tab |
| 下一個 tab | `mod+shift+]` | 同 project 內切 tab |
| 新建 tab | `mod+T` | 在當前 project 開新 terminal |

`mod` = Cmd（macOS）/ Ctrl（Windows/Linux），跨平台統一。
所有快捷鍵可自訂，持久化到 localStorage。

### 圖片貼上

- 在 terminal 中 `mod+V` 時，若 clipboard 包含圖片，自動存為 temp file 並將路徑貼入 terminal
- 圖片存放目錄：`/tmp/shelf-paste/`（或 OS 對應的 temp 目錄）
- 清理策略：定時清除過期檔案（如每小時清除超過 1 小時的圖片）+ App 關閉時清除整個目錄
- 用途：搭配 Claude CLI 等支援圖片路徑的工具，實現截圖後直接貼上

### Project Status 燈號

| 狀態 | 意義 |
|------|------|
| 🟢 green | 至少一個 pty process alive |
| ⚫ grey | 沒有任何 tab / 所有 pty 已結束 |

MVP 只需要這兩種。

## 資料模型

### 新建 Project 流程

1. 選擇連線方式（local 為預設，MVP 可跳過此步驟）
2. FolderPicker 選擇資料夾（local 列本機目錄、SSH 列遠端目錄）
3. 建立 project，自動開第一個 terminal tab（cwd 為所選資料夾）

所有新 tab 的起始路徑固定為 project 的 cwd。

### Project Config（持久化）

```typescript
type LocalConnection = { type: 'local' };
type SSHConnection = { type: 'ssh'; host: string; port: number; user: string };

interface ProjectConfig {
  id: string;
  name: string;           // 顯示名稱（預設為資料夾名）
  cwd: string;            // 資料夾路徑（local 為本機路徑、SSH 為遠端路徑）
  connection: LocalConnection | SSHConnection;  // MVP 只實作 local
  maxTabs: number;         // 預設 5
}
```

### Runtime State（不持久化）

```typescript
interface ProjectState {
  tabs: TabState[];
  activeTabIndex: number;
}

interface TabState {
  id: string;
  label: string;          // "Terminal 1", "Terminal 2", ...
  ptyProcess: IPty;       // node-pty instance
  xterm: Terminal;         // xterm.js instance（renderer 端）
}
```

## IPC Protocol

Main ↔ Renderer 之間的通訊：

```typescript
// Renderer → Main
'pty:spawn'    → { projectId, tabId }         // 開新 pty
'pty:input'    → { tabId, data }              // 鍵盤輸入
'pty:resize'   → { tabId, cols, rows }        // 視窗大小
'pty:kill'     → { tabId }                    // 關閉 tab

// Main → Renderer
'pty:data'     → { tabId, data }              // terminal 輸出
'pty:exit'     → { tabId, exitCode }          // pty 結束
```

## 不做的事（MVP）

- ❌ Agent UI（MessageList、PermissionBanner 等）
- ❌ AI SDK 串接
- ❌ Remote 連線（WSL、SSH）
- ❌ 分割畫面
- ❌ Tab 重建（app 重啟後恢復 pty 狀態）
- ❌ 搜尋 terminal 內容
- ❌ Terminal 內容持久化

## 未來方向（v2+）

### Remote 連線

```typescript
// connectionType 擴展
type ConnectionType = 'local' | 'wsl' | 'ssh';

interface SSHConfig {
  host: string;
  port: number;
  user: string;
  // SSH multiplexing: ControlMaster + ControlPath
}

interface WSLConfig {
  distro: string;  // e.g. 'Ubuntu'
}
```

| Type | spawn 方式 |
|------|-----------|
| `local` | `pty.spawn($SHELL, [], { cwd })` |
| `wsl` | `pty.spawn('wsl.exe', ['-d', distro])` |
| `ssh` | `pty.spawn('ssh', [ControlMaster 參數, user@host])` |

SSH 使用 ControlMaster multiplexing，同 project 的多個 tab 共用 TCP 連線。

### 圖片貼上 — Remote 支援

- SSH session 中貼上圖片時，透過 SCP/SFTP 將圖片傳到遠端 temp 目錄，貼上遠端路徑
- 需偵測當前 tab 是否為 SSH session（從 ProjectConfig.connection 判斷）

### 其他

- 分割畫面（如需要）
- Tab 命名 / 拖曳排序
- Terminal 主題自訂
- xterm.js 問題修正（中文輸入、貼上）
