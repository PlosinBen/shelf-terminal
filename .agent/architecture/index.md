# Architecture

Abstract data flow at the system level (component names, no filenames).

| Intent | File | One-line summary |
|---|---|---|
| 終端 I/O 流 | [terminal-io](terminal-io.md) | keypress → 快捷鍵層 → pty → 輸出；貼上/拖檔 → staging → shell |
| 連線生命週期 | [connection-lifecycle](connection-lifecycle.md) | connect → connector → shell/exec；部署、heartbeat、idle-shutdown |
| Agent turn | [agent-turn](agent-turn.md) | user msg → send queue → provider turn → 渲染原語 → timeline |
| PM 控制迴圈 | [pm-control](pm-control.md) | 訊息 → PM turn → 寫入 terminal → 觀察回饋 |
| Skills 投影 | [skills-projection](skills-projection.md) | UI 編輯 → 投影 → provider 載入 → live hot-reload |
| MCP config sync | [mcp-sync](mcp-sync.md) | UI 編輯 → sibling pipeline → 投影/transport → agent-server 解析餵 SDK → reconnect 通知 |
| 型別宣告檔案傳輸 | [transport](transport.md) | client 宣告 type、worker 組路徑;byte-mover 與 deploy-plane extras 分層 |
| 背景任務 | [background-tasks](background-tasks.md) | task lane 與前景 turn 解耦；卡片獨立 settle；auto-resume |
