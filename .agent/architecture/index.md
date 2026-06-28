# Architecture

Abstract data flow at the system level (component names, no filenames).

| Intent | File | One-line summary |
|---|---|---|
| 終端 I/O 流 | [terminal-io](terminal-io.md) | keypress → 快捷鍵層 → pty → 輸出；貼上/拖檔 → staging → shell |
| 連線生命週期 | [connection-lifecycle](connection-lifecycle.md) | connect → connector → shell/exec；部署、heartbeat、idle-shutdown |
| Agent turn | [agent-turn](agent-turn.md) | user msg → send queue → provider turn → 渲染原語 → timeline |
| PM 控制迴圈 | [pm-control](pm-control.md) | 訊息 → PM turn → 寫入 terminal → 觀察回饋 |
| Skills 投影 | [skills-projection](skills-projection.md) | UI 編輯 → 投影 → provider 載入 → live hot-reload |
| 背景任務 | [background-tasks](background-tasks.md) | task lane 與前景 turn 解耦；卡片獨立 settle；auto-resume |
