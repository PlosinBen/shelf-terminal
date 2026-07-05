# Contracts

Exact interface specs / message formats. Point to source types rather than duplicate them.

| Intent | File | One-line summary |
|---|---|---|
| renderer↔main IPC 介面 | [ipc-channels](ipc-channels.md) | `window.shelfApi.*` surface，按領域分 |
| agent wire 協定 | [agent-wire-protocol](agent-wire-protocol.md) | turnId envelope + 渲染原語訊息變體；sid addressing + 兩層 dispatch boundary |
| agent 控制/路由訊息 | [agent-routing](agent-routing.md) | slash dispatch、config edit、picker、app_tool、stop/queue |
| Connector 介面 | [connector-interface](connector-interface.md) | factory + createShell/exec/listDir/… + 連線型別 |
| 磁碟持久化格式 | [persistence-formats](persistence-formats.md) | projects/settings/notes/skills/投影/context layout |
| app-tool bridge 協定 | [app-tool-bridge](app-tool-bridge.md) | `app_tool` 訊息 + `op=resource.verb` registry |
