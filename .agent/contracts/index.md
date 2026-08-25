# Contracts

Exact interface specs / message formats. Point to source types rather than duplicate them.

| Intent | File | One-line summary |
|---|---|---|
| renderer↔main IPC 介面 | [ipc-channels](ipc-channels.md) | `window.shelfApi.*` surface，按領域分 |
| External URL intent | [external-url-intent](external-url-intent.md) | typed source、Copy/Open/Cancel round-trip、scheme/length validation、terminal OSC frame |
| agent wire 協定 | [agent-wire-protocol](agent-wire-protocol.md) | executionId control envelope + session-scoped 渲染原語；sid addressing + 兩層 dispatch boundary |
| process memory 訊息與 summary | [process-memory](process-memory.md) | acquisition request/report、KiB normalization、rollup availability、timing 與 connection identity |
| agent 控制/路由訊息 | [agent-routing](agent-routing.md) | slash dispatch、config edit、picker、app_tool、stop/queue |
| Connector 介面 | [connector-interface](connector-interface.md) | factory + createShell/exec/listDir/… + 連線型別 |
| 磁碟持久化格式 | [persistence-formats](persistence-formats.md) | projects/settings/notes/skills/投影/context layout |
| app-tool bridge 協定 | [app-tool-bridge](app-tool-bridge.md) | `app_tool` 訊息 + `op=resource.verb` registry |
| canonical project contract | [projects](projects.md) | canonical model、main repository/IPC operations、flat renderer views、project intents與 feature-note snapshots |
