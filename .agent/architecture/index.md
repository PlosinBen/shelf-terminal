# Architecture

Abstract data flow at the system level (component names, no filenames).

| Intent | File | One-line summary |
|---|---|---|
| 終端 I/O 流 | [terminal-io](terminal-io.md) | target facts → runner/init phases → 互動 I/O；附件 staging 與 external URL control frame |
| 連線生命週期 | [connection-lifecycle](connection-lifecycle.md) | config → runtime generation → AppOS materialization → shell/exec；部署與 health lifecycle |
| Agent execution / content | [agent-execution](agent-execution.md) | send queue → execution control；session content → CLI 式線性 timeline |
| Agent dispatch | [agent-dispatch](agent-dispatch.md) | main → per-host dispatcher → per-session exec → CLI；sid demux、two-map hosting、two-tier health、reconnect、cache |
| Process memory observability | [process-memory-observability](process-memory-observability.md) | source-owned acquisition → main latest-value registry → retained detail + 30s summary → footer/status bar |
| PM 控制迴圈 | [pm-control](pm-control.md) | 訊息 → PM turn → 寫入 terminal → 觀察回饋 |
| Skills 投影 | [skills-projection](skills-projection.md) | UI 編輯 → 投影 → provider 載入 → live hot-reload |
| MCP config sync | [mcp-sync](mcp-sync.md) | UI 編輯 → sibling pipeline → 投影/transport → agent-server 解析餵 SDK → reconnect 通知 |
| 型別宣告檔案傳輸 | [transport](transport.md) | client 宣告 type、worker 組路徑;byte-mover 與 deploy-plane extras 分層 |
| 背景任務 | [background-tasks](background-tasks.md) | task lane 與前景 execution 解耦；卡片獨立 settle；auto-resume content |
| Config 備份/複製 | [config-backup](config-backup.md) | selected whole-item copy out/in；scoped Backup、pinned transactional Import、shared side-car serialization |
| 專案 env 注入 | [project-env](project-env.md) | plain+secret → 單一 resolve 出口 → 注入每個 spawn（agent-server/dispatcher/terminal）；dispatcher 走 open_session |
| Worktree lifecycle | [worktree](worktree.md) | proposal gate → configured note binding/snapshot → create/finish/abandon transaction → parent completion |
| Project repository boundary | [projects](projects.md) | versioned document → canonical main authority → durable operation/refresh → runtime-composed flat views |
