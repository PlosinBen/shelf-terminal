# Context

Decisions + gotchas grouped by topic. Cited from code as `<topic>#N`.

| Intent | File | One-line summary |
|---|---|---|
| 終端輸入/輸出、pty、xterm | [terminal-pty](terminal-pty.md) | TerminalView spawn、HISTFILE、xterm addon 雷 |
| local/SSH/WSL/Docker 連線抽象 | [connector](connector.md) | connector factory、ControlMaster、exec、branch 切換 |
| 檔案上傳 / 貼上 / 清理 | [file-transfer](file-transfer.md) | `.tmp/shelf/`、cat-via-stdin、session-based cleanup |
| 設定 merge、bootstrap、userData 隔離 | [settings-config](settings-config.md) | shallow+deep merge、開窗前載 config、DEFAULT_SETTINGS |
| app 快捷鍵 / 視窗 shell 行為 | [keybindings-shell](keybindings-shell.md) | capture phase、外部連結、DevTools、IME composition |
| per-project 檔案儲存、notes | [storage](storage.md) | `projects/<id>/`、notes file storage + GC |
| 打包 / CI / 簽章 | [build-packaging](build-packaging.md) | electron-builder、code signing、E2E build |
| PM agent | [pm-agent](pm-agent.md) | Telegram 遙控、away/active、雙層 prompt、rolling note |
| agent 核心架構 | [agent-core](agent-core.md) | provider SDK、tab state、持久化、send queue |
| agent 事件不靜默丟棄 | [agent-observability](agent-observability.md) | 每個事件都要留痕(renderer/logger)、default/else 守門、orphan tool card 兩方向 fail-loud |
| Claude/Copilot provider 差異 | [agent-providers](agent-providers.md) | 行為一致差異封裝、登入、model registry、permission |
| agent UI 渲染 | [agent-ui](agent-ui.md) | plan panel、status bar、picker、event/store、渲染原語 |
| slash / config / model 流 | [agent-config-flow](agent-config-flow.md) | turnId envelope、slash dispatch、applyConfigEdit |
| 背景任務 | [background-tasks](background-tasks.md) | task_event lane、streaming session、auto-resume |
| 連線健康 | [connection-health](connection-health.md) | ping/pong heartbeat、idle-shutdown watchdog |
| 部署 / 投影 | [deployment](deployment.md) | `~/.shelf/` taxonomy、cp-to-remote 投影、agent-server bundle |
| app 層 skills | [skills](skills.md) | 開放標準 + 投影、bridge、hot-reload、lock |
| app 層 MCP servers | [mcp](mcp.md) | additive-on-native、keyed-object opaque、sibling pipeline、reconnect 通知、heartbeat lease、scope 傳達 |
| Web tab + agent web.fetch | [web-tab](web-tab.md) | 網路身分跟 connection、per-origin grant gate、webview hardening、away/timeout |
