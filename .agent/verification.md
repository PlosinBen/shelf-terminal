---
type: reference
title: Shelf — 驗證能力與執行入口
---

# 驗證能力與執行入口

本檔描述可使用的能力、前提與證據限制，不代表任何測試目前通過。依本次變更選擇檢查並對照實際設定；執行結果保存在該次工作記錄或 artifacts。

## 規則與前提

- 依 [CLAUDE.md](../CLAUDE.md) 的 Development／Rules 執行：bug fix 先寫重現測試；renderer 行為變更同批交付 E2E。純文件修改以來源、格式與連結檢查為主，不因此啟動產品。
- Node.js 22+；依 [package.json](../package.json) 安裝專案依賴。`postinstall` 包含 Electron native module rebuild，需相應建置環境。沒有安裝依賴不等於產品測試失敗。
- 優先使用 npm scripts。不要啟動 `npm run dev` 或直接開 Electron 干擾使用者；UI 行為走既有測試 fixture。
- E2E 包含 build、耗時較長，依 repo 規則用可背景執行的工具啟動，保留輸出並追蹤完成；無背景工具時如實指出限制，不宣稱已執行。
- 以下能力由 scripts／設定／代表性 fixture 盤點；操作 recipe 尚未經完整 runtime 演練，使用時確認目標環境的實際可用性。

## 能力與入口

命令定義以 [package.json](../package.json) 為準；測試選取以 [vitest.config.ts](../vitest.config.ts) 與 [playwright.config.ts](../playwright.config.ts) 為準。各功能的測試契約與特定操作注意事項見 [Testing Practices](context/testing.md)，本檔不重複其逐功能說明。

| 行為／範圍 | 入口 | 能證明與限制 |
|---|---|---|
| TypeScript 靜態相容性 | `npm run typecheck` | 型別檢查；不能證明 runtime／UI 行為 |
| 模組與 provider 邏輯 | `npm run test:unit`；篩選時 `npm run test:unit -- <test-file>` | 收集 `src/**/*.test.ts`、`agent-server/**/*.test.ts`；各 spec 決定 mock／真實邊界，不將整套一概稱為純函式測試 |
| 主機程序記憶體取得 | `npm run test:memory-host` | [host integration test](../src/shared/process-memory-sampler.integration.test.ts) 使用真實平台 adapter；依主機支援判斷執行，不證明其他平台 |
| Renderer／IPC／main／agent wire | `npm run test:e2e`；單一 spec 如 `npm run test:e2e -- e2e/skills.spec.ts` | [共用 fixture](../e2e/helpers.ts) 啟動實際 Electron，但 backend 換 fake provider；不能據此宣稱真實 SDK／登入／模型服務已驗證 |
| Docker connector | `npm run test:docker` | 真實 Docker fixture；需 Docker daemon、可取得 image，檢查 [docker spec](../e2e/connector/docker.spec.ts) 的具體行為與前提 |
| SSH connector | `npm run test:ssh` | script 啟動本機 SSH 測試容器；檢查 [SSH spec](../e2e/connector/ssh.spec.ts) 與 [設定](../e2e/connector/ssh-config.ts)，不能推論任意遠端／SSO 已通過 |
| 遠端 agent 部署、binary／runtime | `npm run test:agent-deploy -- <spec>` | 需 Docker、網路與所選 spec 的前提；[部署 fixture](../e2e/connector/agent-deploy-helpers.ts) 預設 fake，可選真實 backend probe；需讀 spec 區分下載、啟動、未登入偵測與真正已登入操作 |
| SSH 密碼認證與 agent 部署 | `npm run test:agent-deploy-ssh` | [SSH 部署 spec](../e2e/connector/agent-deploy-ssh.spec.ts) 需 Docker 與 Unix SSH／SCP，Windows skip；測試自建容器並使用動態 port，以 fake provider 驗 dispatcher／direct 兩條部署路徑、app command 遠端投影與排隊後停用重驗，不證明真實模型登入或對話 |
| WSL upload／部署 | `npm run test:wsl`、`npm run test:agent-deploy-wsl` | Windows 主機與可用 distro；[WSL spec](../e2e/connector/wsl.spec.ts) 在非 Windows skip，不把 macOS／Linux 執行當作 WSL 通過 |

從受影響模組的既有測試或 `e2e/` 對應 spec 選起，不為每個任務重建完整 inventory。`npm test` 串接 typecheck、unit、一般 E2E、Docker、SSH，未包含所有 WSL／agent-deploy 專案，也不是每次局部變更都要重跑的預設。

## 環境隔離與副作用

- 一般 E2E 每個 test 建立 `shelf-e2e-*` 暫存 userData，以 `NODE_ENV=test` 啟動隱藏視窗並等待 `.app`。設定使用一個 worker，但不同 checkout 的獨立測試程序仍可能互相影響。
- 共用 fixture 預設還會建立及清理主機 home 下固定的 `shelf-test-a`／`shelf-test-b`／`shelf-test-c` 目錄；userData 隔離不代表所有主機資源都隔離。執行前確認不與其他測試或使用者資料衝突。 不使用這些具名專案目錄的測試可在 describe 範圍設定 `test.use({ homeProjectDirectories: false })`，同時略過建立與清理；此選項不隔離產品本身的 home 寫入。
- Docker／SSH scripts 使用固定 `shelf-test-container` 名稱與 host port 2222；部署 script 也使用固定容器名。先確認可用性，不移除他人的容器以取得空位，不同 runs 避免併發使用這些資源。
- 部署 fixture 使用跨 run 重用的 runtime cache；驗證首次部署時，必須辨認 cache 對主張的影響。
- 持久化功能除了 DOM 結果，也應按相應 spec 檢查該次 userData 或目標檔案／資料；不要只以畫面完成狀態推論寫入成功。

## 證據與診斷

| 證據 | 取得方式與限制 |
|---|---|
| 命令結果 | 保留 script／spec、版本或工作樹狀態、環境、輸出與結果；skip／未執行另外列出 |
| App log | [main 初始化](../src/main/index.ts) 寫入 `<該次 userData>/logs/<YYYYMM>/<MMDD>.log`；[logger](../src/shared/logger.ts) 與 settings 控制 level，`LOG_LEVEL` 可覆寫。低於目前 level 的訊息不會落檔 |
| Renderer 診斷 | `debugLog` 經 [logs IPC](../src/main/ipc/logs.ts) 以 info 記入 main log；確認該次 level 有包含 info |
| Playwright artifacts | 設定為 `screenshot: 'only-on-failure'`、`trace: 'on-first-retry'`，但 `retries: 0` 不會因 retry 啟動 trace。fixture 自行 `electron.launch`／取得 page，不能僅憑設定保證自動截圖；實際確認 reporter 輸出的路徑與內容。`test-results/` 已 gitignored，但存在不代表證據完整 |
| 真實 provider／部署 | 記錄所選 spec、是否 fake、登入與平台前提；成功下載或未登入狀態辨識，不等於已驗證真實已登入對話 |

`test:docker`／`test:ssh` scripts 在測試後以分號接 `docker rm -f`，最後清理成功可能掩蓋前段失敗 exit code。檢查完整 Playwright 結果與前置錯誤，不單憑 wrapper 回傳 0 宣告通過；本檔記錄限制，未修正 scripts。

## 清理與證據保留

- 一般 fixture 在測試結束關閉自己啟動的 Electron、清理固定測試目錄並刪除該次 userData。需要 log 或持久化檔案時，必須在 teardown 前保留到該次 artifact 位置；不能等結束才假設暫存資料仍在。
- 部署 fixture 同樣清除 userData，其 runtime cache 有意保留供後續重用。依實際 fixture／script 確認本次建立的資源。
- 只清理本次擁有的程序、目錄與容器，保留證據，不操作既有使用者 instance 或清除全域資料。
- 需要改 fixture／script 才能收集證據時，依 repo worktree 與測試規則進行；不能把尚未實作的收集方式寫成已有能力。

## 覆蓋缺口與維護

- 平台專屬行為需要相應主機，外部登入／服務需要實際可用前提。先完成能獨立執行的檢查，再列出未驗證項目，不降低需求或把缺環境判成通過。
- [release workflow](../.github/workflows/build.yml) 的 test job 執行 typecheck 與 unit，E2E 另依本機規範驗證；release CI 綠燈不代表所有產品行為與平台都驗過。
- 變更 scripts、harness、auth／平台前提、log／artifact 或清理機制時，同批更新本檔及必要入口。具體設定與 spec 保持 source of truth，本檔不維護歷次通過紀錄。
