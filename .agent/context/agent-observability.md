---
type: context
title: Agent event pipeline — no silent drops
related:
  - context/agent-core
  - context/agent-providers
  - contracts/agent-wire-protocol
---

# Agent event pipeline — no silent drops

> 從 provider SDK event → agent-server → wire → renderer → IndexedDB 的整條路上,**任何事件(正常或異常)都必須留下痕跡**。這是 `CLAUDE.md`「禁止靜默吞錯 / 丟資料」在 agent 管線的具體落實。

## agent-observability#1 — 每個事件都要有痕跡:renderer 或 logger,二選一至少有一  ·  [Decision]

**Background**：agent 是 event-driven —— provider SDK 吐 message / stream / tool_use / tool_result / task event,agent-server 翻成渲染原語送 renderer,renderer 存進 IndexedDB(`shelf-agent-history`,見 `contracts/persistence-formats`)。中間任何一個 `return;` / `break;` / `catch {}` 把事件默默丟掉,就等於**銷毀了還原現場的證據**。

**Decision**：**沒有靜默丟棄。** 每個進來的事件,結局只能是二者之一:
1. **發到 renderer**(某個 `msgType`)→ 使用者看得到、且被 IndexedDB 持久化 → 事後可還原。
2. **落 logger**(`serverLog(...)`)→ 至少 log 檔裡有痕跡可 debug。

分級(照 `CLAUDE.md`):**真資料 / 使用者可見內容遺失 → 大聲**(`warn`/`error`,而且盡量也發一張 error 卡到 renderer);**良性 race / 預期 no-op → 低調**(`debug`),但**仍要留一筆**。高頻未知型別用 dedup(`seenUnknownWire` / `seenUnhandledCopilotEvents`)避免洗版,但**第一次一定 log**。

**Do not change casually because**：這條是「為什麼很多 agent 狀況難還原」的根治。實例:一段連續 32 張 tool 卡沒 body,就是因為 `emitClaudeToolResult` 的 `if (!entry) return`(靜默)—— 要不是去挖 IndexedDB 根本查不到。已補的守門點:claude/copilot 的 `processMessage`/dispatcher **default case**(未知 SDK message type)、claude `content_block_delta` 未知 delta type、`exec.ts` 主 dispatcher default(未知 wire 指令)、router-drift `case 'ignore'`(warn + session-scoped 重發)。新增 event handler / switch **一律**要有 default 或 else 留痕。

**Related**：`agent-observability#2`、`agent-server/providers/{claude,copilot}/index.ts`、`agent-server/exec.ts`。

## agent-observability#2 — Orphan tool card:兩個方向都要 fail-loud + 收斂  ·  [Gotcha]

**Background**：tool 卡是「pending → completed」的 upsert(同 msgId):`tool_use` 先發一張沒 body 的卡並在 process-local 的 `inflightToolUses` map 登記;`tool_result` 回來時靠 map 補 body。map 是 **module-level = 每個 agent-server 程序一份**,只有 `/clear` 會清。

**Gotcha**：session 若被**換手到新的 agent-server 程序**(reconnect / idle-shutdown 重生 / 第二個 window 接手),新程序的 map 是空的 → 兩個方向都會 orphan:
- **result 找不到 use**（result 回到空 map）：claude 舊 code `if (!entry) return`、copilot `if (!entry) break` **靜默吞掉** → 卡永遠空白。**已改**:fail-loud log + 發一張帶 `errorMessage` 的 fold_code(claude 還保留原始 output;copilot 的 complete event 不帶 output,只能發錯誤)。copilot 用 `suppressedToolIds` 把良性的 `task_complete`/`report_intent`(故意不登記)跟真 orphan 區分開。
- **use 等不到 result**（卡卡在 map、result 沒回來）：copilot 有 `finalizeOrphanedToolCards`(turn 結束掃 map、每張發「did not complete」+ log);**claude 目前沒有這個掃尾**（reload 時 renderer 的 `reviveOrphanPending` 會補「Session ended before completion」,但 live 沒收斂）→ 已知待補。

**Do not change casually because**：真正的根因是「live session 被換到新程序、舊 in-memory 狀態被孤立」。上面的 fail-loud 是止血 + 裝偵測 —— orphan 的 warn log 會指出是哪個 lifecycle 事件清空了 map,再據此修根因。

**Related**：`agent-observability#1`、`context/connection-health`、`context/agent-core`。
