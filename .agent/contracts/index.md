# Contracts

Exact interface specs / message formats. Point to source types rather than duplicate them.

共用的 type 標籤、wire kind、event name、IPC channel 和固定路徑片段，由單一 `const` 或 `as const` 定義。型別可從常數用 `keyof typeof` 或 `typeof` 推導，避免另外維護相同的值集合。實例見 [IPC](../../src/shared/ipc-channels.ts) 和 [Shelf 路徑常數](../../src/shared/shelf-paths.ts)（`ShelfFileTypeMcp`、`SHELF_PLACEMENTS`）。

| Intent | File | One-line summary |
|---|---|---|
| renderer↔main IPC 介面 | [ipc-channels](ipc-channels.md) | `window.shelfApi.*` surface，按領域分 |
| External URL intent | [external-url-intent](external-url-intent.md) | typed source、Copy/Open/Cancel round-trip、scheme/length validation、terminal OSC frame |
| agent wire 協定 | [agent-wire-protocol](agent-wire-protocol.md) | executionId control envelope + session-scoped 渲染原語；sid addressing + 兩層 dispatch boundary |
| process memory 訊息與 summary | [process-memory](process-memory.md) | acquisition request/report、KiB normalization、rollup availability、timing 與 connection identity |
| agent 控制/路由訊息 | [agent-routing](agent-routing.md) | slash dispatch、config edit、picker、app_tool、stop/queue |
| Worktree Agent 委派 | [agent-delegation](agent-delegation.md) | 選擇授權、連續階段、MCP 狀態／進度、人工提取與關閉 |
| Connector 介面 | [connector-interface](connector-interface.md) | factory + createShell/exec/listDir/… + 連線型別 |
| Terminal control protocol | [terminal-control](terminal-control.md) | launch plans、target-facts frame、OSC init lifecycle與 renderer phase projection |
| 磁碟持久化格式 | [persistence-formats](persistence-formats.md) | projects/settings/notes/skills/投影/context layout |
| app-tool bridge 協定 | [app-tool-bridge](app-tool-bridge.md) | `app_tool` 訊息 + `op=resource.verb` registry |
| canonical project contract | [projects](projects.md) | canonical model、main repository/IPC operations、flat renderer views、project intents與 feature-note snapshots |
| Skill commands | [skill-commands](skill-commands.md) | sidecar、editor/menu IPC、submission binding、queue revalidation 與 native dispatch 邊界 |
