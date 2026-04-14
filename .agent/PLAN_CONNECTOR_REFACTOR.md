# Refactor: Connector 抽象化

## Context

目前 connection type dispatch（switch on connection.type）散在四處：pty-manager、connection-manager、file-transfer、preload。OS 判斷也零星散在 pty-manager。這次要統一收進 connector 抽象，每個 connection type 一個完整實作，內部處理自己的 OS 差異。

## 平台 × Connection 支援矩陣

| Connection | macOS | Windows | Linux |
|---|---|---|---|
| local | zsh/bash -l + shellEnv | powershell | zsh/bash -l + shellEnv |
| ssh | ControlMaster | 無 ControlMaster（每次重新連） | ControlMaster |
| wsl | 不顯示 | wsl.exe | 不顯示 |
| docker | docker (PATH) | docker (PATH) | docker (PATH) |

---

## 職責劃分

### Connector 負責
- **給出一個 shell**：`createShell(cwd)` → Shell（內部處理 OS 差異、env 解析、args 組裝、pty.spawn）
- **檔案操作**：uploadFile, cleanupSession, clearUploads
- **檔案系統查詢**：listDir, homePath
- **連線管理**：connect, isConnected

### pty-manager 負責（拿到 Shell 之後）
- Shell 生命週期管理（存 map, kill, resize, write 轉發）
- initScript / tabCmd 注入（等 shell ready 再送）
- idle notification

### file-transfer 負責
- upload prefix 解析（`parseUploadPrefix`）
- scheduling 邏輯（`maybeScheduleCleanup`）
- 呼叫 connector 的 upload/cleanup 方法

---

## 統一介面

```typescript
// src/main/connector/types.ts

export interface Disposable {
  dispose(): void;
}

/** Connector 回傳的 shell session，外部不耦合 node-pty */
export interface Shell {
  onData(cb: (data: string) => void): Disposable;
  onExit(cb: (exitCode: number) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface Connector {
  // ── Shell ──
  createShell(cwd: string): Shell;

  // ── Connection lifecycle ──
  isConnected(): Promise<boolean>;
  connect(password?: string): Promise<void>;

  // ── File system ──
  listDir(dirPath: string): Promise<FolderListResult>;
  homePath(): Promise<string>;

  // ── File transfer ──
  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string>;
  cleanupSession(cwd: string, cutoffMs: number): Promise<number>;
  clearUploads(cwd: string): Promise<number>;
}
```

> **Shell 包裝 node-pty**：各 connector 的 `createShell()` 內部呼叫 `pty.spawn()` 後，
> 將 IPty 包成 Shell 回傳（onExit 壓平為只有 exitCode）。pty-manager 完全不 import node-pty。

---

## 檔案結構

```
src/main/connector/
  types.ts              — Shell, Disposable, Connector 介面
  shell-env.ts          — resolveShellEnv()（macOS/Linux GUI app env 修正）
  local/
    unix.ts             — macOS + Linux 共用
    win32.ts            — Windows
  ssh/
    unix.ts             — ControlMaster 版（macOS + Linux）
    win32.ts            — 無 ControlMaster（Windows）
  wsl.ts                — WSL（win32 only）
  docker.ts             — Docker（跨平台，無 OS 差異）
  wrap-pty.ts           — wrapPty(IPty): Shell 共用包裝
  index.ts              — factory + getAvailableTypes + listDockerContainers + listWSLDistros + cleanupConnectors
```

## Factory（index.ts）

**所有平台判斷封裝在 factory 內部**，外部只用以下 function：

```typescript
export function createConnector(connection: Connection): Connector { ... }
export function getAvailableTypes(): ConnectionType[] { ... }
export function listDockerContainers(): Promise<string[]> { ... }  // 選 docker 時才呼叫
export function listWSLDistros(): Promise<string[]> { ... }        // 選 wsl 時才呼叫
export function cleanupConnectors(): void { ... }                  // app quit 時呼叫，清 SSH sockets
```

`createConnector` 內部邏輯：
- `local` + unix → `local/unix.ts`
- `local` + win32 → `local/win32.ts`
- `ssh` + unix → `ssh/unix.ts`（ControlMaster）
- `ssh` + win32 → `ssh/win32.ts`（無 ControlMaster，每次重新連）
- `wsl` + win32 → `wsl.ts`
- `wsl` + 非 win32 → throw（不支援）
- `docker` → `docker.ts`（所有平台）

`getAvailableTypes` 內部邏輯：
- win32 → `['local', 'ssh', 'wsl', 'docker']`
- 非 win32 → `['local', 'ssh', 'docker']`

---

## 各實作細節

### `shell-env.ts`
- 從 pty-manager 搬出 `resolveShellEnv()`
- export `getShellEnv(): Record<string, string>`
- macOS/Linux: 啟動時跑 `$SHELL -ilc env` 抓完整 login shell env
- Windows: 直接回傳 `process.env`

### `local/unix.ts`（macOS + Linux）
- `createShell(cwd)`: `pty.spawn(resolveShell(), ['-l'], { env: getShellEnv(), cwd })` → 包成 Shell
- `isConnected()`: always true
- `connect()`: no-op
- `listDir()`: 搬自 `folder-list.ts`
- `homePath()`: `os.homedir()`
- `uploadFile/cleanup/clear`: 搬自 `file-transfer.ts` 的 local 分支

### `local/win32.ts`（Windows）
- `createShell(cwd)`: `pty.spawn('powershell.exe', [], { env: process.env, cwd })` → 包成 Shell
- 其餘同 unix（listDir 用 fs，homePath 用 os.homedir）

### `ssh/unix.ts`（macOS + Linux）
- `createShell(cwd)`: SSH args + ControlMaster → `pty.spawn('ssh', args, ...)` → 包成 Shell
  - import `getControlPath`, `getKnownHostsPath` from `ssh-control.ts`
- `isConnected()`: 檢查 ControlMaster socket 是否存在
- `connect(password?)`: 搬自 `ssh-manager.ts` 的 `sshEstablishConnection()`
- `listDir()`: 搬自 `ssh-manager.ts`（走 ControlMaster 複用連線）
- `homePath()`: 搬自 `ssh-manager.ts`
- `uploadFile/cleanup/clear`: 搬自 `file-transfer.ts` 的 ssh 分支

### `ssh/win32.ts`（Windows）
- `createShell(cwd)`: SSH args **不帶** ControlMaster → `pty.spawn('ssh', args, ...)` → 包成 Shell
- `isConnected()`: 嘗試 ssh 指令確認（無 socket 可檢查）
- `connect(password?)`: 同 unix 但不建立 ControlMaster
- `listDir()`: 每次獨立 SSH 連線執行 ls
- `homePath()`: 每次獨立 SSH 連線執行 echo $HOME
- `uploadFile/cleanup/clear`: 同 unix 但每次獨立連線

### `wsl.ts`（win32 only）
- `createShell(cwd)`: `pty.spawn('wsl.exe', ['-d', distro, ...], ...)` → 包成 Shell
- `isConnected()`: always true
- `connect()`: no-op
- `listDir/homePath`: 搬自 `wsl-manager.ts`
- `uploadFile/cleanup/clear`: 搬自 `file-transfer.ts` 的 wsl 分支

### `docker.ts`（跨平台）
- `createShell(cwd)`: `pty.spawn('docker', ['exec', '-it', container, ...], ...)` → 包成 Shell
  - binary 用 `docker`，靠 env PATH 找
- `isConnected()`: 搬自 `docker-manager.ts` 的 `dockerIsRunning()`
- `connect()`: no-op
- `listDir/homePath`: 搬自 `docker-manager.ts`
- `uploadFile/cleanup/clear`: 搬自 `file-transfer.ts` 的 docker 分支
- 額外 export: `listContainers()` — docker 特有，UI 需要

---

## SSH Server 歷史記錄

用過的 SSH 設定自動記住，新增 project 時可重複選用。

### 儲存
- 每次 SSH 連線成功後，自動存 `{ host, port, user }` 到 `ssh-servers.json`（跟 projects.json 同層）
- 去重：相同 host+port+user 不重複存

### IPC
- `CONNECTOR_SSH_SERVERS` — 回傳所有儲存的 SSH servers
- 連線成功時 main process 自動 append（去重），不需要 renderer 主動存

### UI（在 FolderPicker.tsx）
- 選 SSH connection type 時，表單上方顯示歷史 server 清單
- 顯示為 `user@host:port`，點選自動帶入 host/port/user 欄位
- 不需要命名、編輯、刪除功能

---

## Renderer 端改動（FolderPicker.tsx）

### 移除 renderer 層的平台判斷
- 刪除 `navigator.platform.includes('Win')` 判斷
- 改為啟動時呼叫 `getAvailableTypes()` 取得可用 connection types
- Connection type 按鈕只顯示可用的 types

### 移除 per-type API 呼叫
- `shelfApi.wsl.listDistros()` → 改為 `shelfApi.connector.listOptions('wsl')` 或統一 IPC
- `shelfApi.docker.listContainers()` → 同上
- 不再直接呼叫 per-type 的 preload API

### 新增 SSH server 歷史
- 選 SSH 時，先從 `shelfApi.connector.sshServers()` 取得歷史清單
- 表單上方顯示 server 列表，點選帶入欄位
- 無歷史時直接顯示空表單（跟現在一樣）

### Docker container refresh 按鈕
- Container `<select>` 旁邊加一個 refresh 按鈕
- 點擊重新呼叫 `listDockerContainers()` 更新清單

---

## Docker Path 設定

### 全域 Settings
- `AppSettings` 新增 `dockerPath?: string`，default 不填（用 `docker`，靠 PATH 找）
- Settings UI 加 Docker Path 欄位 + Test 按鈕
- Test：用指定 path 執行 `docker version`，成功顯示 ✓，失敗顯示錯誤訊息

### IPC
- `CONNECTOR_TEST_DOCKER` — 帶 path 參數，回傳成功/失敗

### Connector 整合
- `docker.ts` 讀取 settings 的 `dockerPath`，有值就用，沒值就 `'docker'`

---

## 消費端簡化

### `pty-manager.ts`
```typescript
export function spawnPty(projectId, tabId, cwd, connection, win, initScript?, tabCmd?) {
  const connector = createConnector(connection);
  const shell = connector.createShell(cwd);

  shells.set(tabId, shell);
  maybeScheduleCleanup(projectId, connection, cwd);

  // initScript 注入（等 shell ready）— 跟現在一樣
  if (initScript || tabCmd) { ... }

  // onData, onExit, notification — 跟現在一樣
}
```

刪除：`resolveShellEnv()`, `resolveShell()`, `buildSSHArgs()`, `shellEscape()`, switch block, `execFileSync` import

### `connection-manager.ts` → 刪除
IPC handler 直接呼叫 `createConnector(connection).isConnected()` / `.connect()`。
SSH cleanup 搬到 `cleanupConnectors()`（connector/index.ts），main process 的 `app.on('will-quit')` 呼叫它。

### `file-transfer.ts`
移除 connection type switch，改為：
```typescript
const connector = createConnector(connection);
return connector.uploadFile(cwd, filename, buffer);
```
保留：`parseUploadPrefix`、`maybeScheduleCleanup` scheduling 邏輯。

### `preload.ts`
移除 connection type routing，統一走一個 IPC channel。

### IPC channels 精簡
移除 per-type channels（`SSH_LIST_DIR`, `WSL_LIST_DIR`, `DOCKER_LIST_DIR` 等），改為：
- `CONNECTOR_LIST_DIR` — 帶 connection 參數
- `CONNECTOR_HOME_PATH` — 同上
- `CONNECTOR_AVAILABLE_TYPES` — 回傳當前 OS 可用的 connection types

保留的 per-type channels（特殊操作）：
- `SSH_REMOVE_HOST_KEY` — SSH 專有
- `CONNECTOR_SSH_SERVERS` — SSH server 歷史清單
- `CONNECTOR_LIST_OPTIONS` — WSL distros / Docker containers 統一查詢

---

## 檔案異動

### 新增
| 檔案 | 內容 |
|---|---|
| `src/main/connector/types.ts` | Shell, Disposable, Connector 介面 |
| `src/main/connector/shell-env.ts` | shell env 解析 |
| `src/main/connector/local/unix.ts` | macOS + Linux local |
| `src/main/connector/local/win32.ts` | Windows local |
| `src/main/connector/ssh/unix.ts` | SSH + ControlMaster（macOS + Linux） |
| `src/main/connector/ssh/win32.ts` | SSH 無 ControlMaster（Windows） |
| `src/main/connector/wsl.ts` | WSL（win32 only） |
| `src/main/connector/docker.ts` | Docker（跨平台） |
| `src/main/connector/wrap-pty.ts` | wrapPty(IPty): Shell 共用包裝 |
| `src/main/connector/index.ts` | factory + getAvailableTypes + listDockerContainers + listWSLDistros + cleanupConnectors |

### 刪除
| 檔案 | 原因 |
|---|---|
| `src/main/ssh-manager.ts` | 搬進 ssh/unix.ts + ssh/win32.ts |
| `src/main/wsl-manager.ts` | 搬進 wsl.ts |
| `src/main/docker-manager.ts` | 搬進 docker.ts |
| `src/main/folder-list.ts` | 搬進 local/*.ts |
| `src/main/connection-manager.ts` | 職責被 connector 取代 |

### 修改
| 檔案 | 變動 |
|---|---|
| `src/main/pty-manager.ts` | 移除所有 connection/OS dispatch，用 `connector.createShell()` |
| `src/main/file-transfer.ts` | 移除 connection dispatch，用 connector 方法 |
| `src/main/index.ts` | IPC handler 改用 createConnector，精簡 channel 註冊 |
| `src/main/preload.ts` | 移除 connection type routing |
| `src/shared/ipc-channels.ts` | 新增統一 channels，移除 per-type channels |
| `src/renderer/components/FolderPicker.tsx` | 移除平台判斷、改用統一 IPC、加 SSH server 歷史 UI |

### 不動
| 檔案 | 原因 |
|---|---|
| `src/main/ssh-control.ts` | 基礎設施，ssh.ts import 它 |

---

## 實作步驟

### Step 1：建 connector 骨架（新舊共存）
- 建 `src/main/connector/` 目錄
- `types.ts` — Shell, Disposable, Connector 介面
- `wrap-pty.ts` — IPty → Shell 共用包裝
- `shell-env.ts` — resolveShellEnv
- `local/unix.ts`, `local/win32.ts`
- `ssh/unix.ts`, `ssh/win32.ts`
- `wsl.ts`, `docker.ts`
- `index.ts` — factory + getAvailableTypes + listDockerContainers + listWSLDistros + cleanupConnectors
- 此時舊檔不動，新舊共存

### Step 2：消費端切換
- `pty-manager.ts` → 用 `createConnector().createShell()`
- `file-transfer.ts` → 用 connector 的 upload/cleanup/clear
- `index.ts`（IPC handlers）→ 用 createConnector + 新增統一 IPC channels
- `preload.ts` → 移除 connection type routing，改用統一 IPC
- `FolderPicker.tsx` → 用 `getAvailableTypes()`，移除 `navigator.platform` 判斷

### Step 3：清理 + 新功能
- 刪除：ssh-manager, wsl-manager, docker-manager, folder-list, connection-manager
- 移除舊 IPC channels（SSH_LIST_DIR, WSL_LIST_DIR 等）
- SSH server 歷史：ssh-servers.json 儲存 + `CONNECTOR_SSH_SERVERS` IPC + FolderPicker UI
- Docker refresh：FolderPicker container 清單旁加 refresh 按鈕
- Docker path：AppSettings 新增 dockerPath + Settings UI + Test 按鈕 + `CONNECTOR_TEST_DOCKER` IPC

---

## 測試影響分析

### 不需修改的測試

| 測試檔案 | 原因 |
|---|---|
| `src/main/updater-state.test.ts`（21 tests） | 純 reducer，不涉及 connection |
| `e2e/app-startup.spec.ts`（3 tests） | 只測基本 layout |
| `e2e/config-bootstrap.spec.ts`（4 tests） | 測 config 檔案處理 |
| `e2e/init-script.spec.ts`（1 test） | 只測 init script 執行，不涉及 connection dispatch |

### 不改測試碼但需確認通過

| 測試檔案 | 說明 |
|---|---|
| `src/main/file-transfer.test.ts`（41 tests） | utility function tests（sanitize, parse, buildPaths 等）完全不變。local file operation tests（cleanupSession, clearUploads, uploadFile）mock fs 層，只要 file-transfer.ts export signature 不變就能通過。`maybeScheduleCleanup` 測試同理 — scheduling 邏輯留在 file-transfer.ts |
| `connector/ssh.spec.ts`（4 tests） | 透過 `window.shelfApi.connector.*` 呼叫。只要 preload API signature 不變（uploadFile, clearUploads），測試不需改 |
| `connector/docker.spec.ts`（3 tests） | 同上 |

### 需要修改的測試

| 測試檔案 | 修改內容 |
|---|---|
| `e2e/project-creation.spec.ts`（8 tests） | `openFolderPicker()` helper 用到 `.conn-type-btn.active`、`.conn-btn-next` 等 selector。如果 FolderPicker connection step UI 改動（availableTypes、SSH server 列表），需要更新 selector 和流程 |
| `e2e/features.spec.ts`（12 tests） | `setupProject()` helper 走相同 FolderPicker 流程，需要跟著改。Settings 測試如果加了 Docker Path 欄位，可能影響 `.settings-input[type="number"]` 的 index |

### 新增的測試

#### Unit tests — `src/main/connector/`

| 測試檔案 | 測試內容 |
|---|---|
| `connector/index.test.ts` | `getAvailableTypes()` 在各平台回傳正確 types；`createConnector()` 回傳對應實作 |
| `connector/wrap-pty.test.ts` | `wrapPty()` 正確轉發 onData/onExit/write/resize/kill，onExit 壓平為 exitCode |
| `connector/shell-env.test.ts` | `resolveShellEnv()` 在非 win32 呼叫 `$SHELL -ilc env`，回傳包含 PATH 的 env |
| `connector/local-unix.test.ts` | `available()` 在非 win32 回傳 true；`createShell()` 使用正確的 shell + args + env |
| `connector/ssh-unix.test.ts` | `available()` 在非 win32 回傳 true；SSH args 包含 ControlMaster/ControlPath/shellEscape |
| `connector/docker.test.ts` | `available()` always true；docker exec args 正確組裝 |

#### E2E tests — 新功能

| 測試檔案 | 測試內容 |
|---|---|
| `e2e/features.spec.ts` 擴充 | Settings 面板顯示 Docker Path 欄位 + Test 按鈕 |
| `e2e/project-creation.spec.ts` 擴充 | FolderPicker SSH 頁面顯示 server 歷史；Docker 頁面有 refresh 按鈕 |

---

## Verification

1. 每步完成後：`npm run typecheck` + `npm run test:unit` 確認沒壞
2. Step 2 完成後：`npm run test` 跑完整 pipeline（typecheck + unit + e2e + docker + ssh），確認 preload API 沒 break
3. Step 3 完成後：`npm run test` 最終驗證
4. 新 connector unit tests 在 Step 1 就寫，確保骨架正確
