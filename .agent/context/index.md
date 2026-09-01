# Context

Decisions + gotchas grouped by topic. Cited from code as `<topic>#N`.

| Intent | File | One-line summary |
|---|---|---|
| 終端輸入/輸出、pty、xterm | [terminal-pty](terminal-pty.md) | TerminalView spawn、project history、init lifecycle、xterm addon 雷 |
| local/SSH/WSL/Docker 連線抽象 | [connector](connector.md) | config/runtime/AppOS 分層、generation facts、ControlMaster、exec |
| 檔案上傳 / 貼上 / 清理 | [file-transfer](file-transfer.md) | `.tmp/shelf/`、cat-via-stdin、session-based cleanup |
| 設定 merge、bootstrap、userData 隔離 | [settings-config](settings-config.md) | shallow+deep merge、開窗前載 config、DEFAULT_SETTINGS |
| app 快捷鍵 / 視窗 shell 行為 | [keybindings-shell](keybindings-shell.md) | capture phase、外部連結、DevTools、IME composition |
| 外部 URL 決策與 terminal launcher 邊界 | [external-url-intent](external-url-intent.md) | main-owned Copy/Open/Cancel gate、typed source、cooperative PTY bridge、敏感 URL 診斷限制 |
| 右側 panel 外框 / resize / width lifecycle | [renderer-shell](renderer-shell.md) | 六個右側 panel 的共用 shell、寬度 policy、相鄰 panel resize gotcha |
| per-project 檔案儲存、notes | [storage](storage.md) | `projects/<id>/`、notes file storage + GC |
| 打包 / CI / 簽章 | [build-packaging](build-packaging.md) | electron-builder、code signing、E2E build |
| PM agent | [pm-agent](pm-agent.md) | Telegram 遙控、away/active、雙層 prompt、rolling note |
| agent 核心架構 | [agent-core](agent-core.md) | provider SDK、tab state、持久化、send queue |
| agent 事件不靜默丟棄 | [agent-observability](agent-observability.md) | 每個事件都要留痕(renderer/logger)、default/else 守門、orphan tool card 兩方向 fail-loud |
| Claude/Copilot provider 差異 | [agent-providers](agent-providers.md) | 行為一致差異封裝、登入、model registry、permission |
| agent UI 渲染 | [agent-ui](agent-ui.md) | plan panel、status bar、picker、event/store、渲染原語 |
| execution / content / slash / config 流 | [agent-config-flow](agent-config-flow.md) | executionId control、session content、slash dispatch、applyConfigEdit |
| 背景任務 | [background-tasks](background-tasks.md) | task_event lane、streaming session、auto-resume |
| 連線健康 | [connection-health](connection-health.md) | ping/pong heartbeat、idle-shutdown watchdog |
| Process memory observability | [process-memory-observability](process-memory-observability.md) | source-owned acquisition、KiB normalization、latest-value/freshness 與 UI/log cadence |
| 部署 / 投影 | [deployment](deployment.md) | `~/.shelf/` taxonomy、cp-to-remote 投影、agent-server bundle |
| app 層 skills | [skills](skills.md) | 開放標準 + 投影、bridge、hot-reload、lock |
| app 層 MCP servers | [mcp](mcp.md) | additive-on-native、keyed-object opaque、sibling pipeline、reconnect 通知、heartbeat lease、scope 傳達 |
| Web tab + agent web.fetch | [web-tab](web-tab.md) | 網路身分跟 connection、per-origin grant gate、webview hardening、away/timeout |
| app 層 config 備份 / 複製 | [config-backup](config-backup.md) | explicit copy 非 sync、selected-item Backup、pinned transactional Import、side-car serialization、local control markers |
| 專案 env（plain + secret） | [project-env](project-env.md) | 兩類 env 單一注入 map、全 connector 注入、dispatcher 走 open_session、secret AES-GCM + key-tier seam、side-car 不同步 |
| Worktree lifecycle | [worktree](worktree.md) | create/finish proposal gates, project-configured note hand-off + child snapshots, provider override |
| Project repository / renderer views | [projects](projects.md) | versioned canonical boundary、main-owned identity、durable recovery、stable views與 Sidebar projection |
| Testing practices | [testing](testing.md) | non-obvious promise coverage、nearby rationale 與 cross-surface review trigger |
