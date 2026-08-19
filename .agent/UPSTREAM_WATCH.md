# Upstream Watch

> 這裡放**「必要追」的上游 issue** —— 我們目前把某個能力留在**退化 / workaround 狀態、要等上游修好才能回復或簡化**的外部問題。
> **每次 release 回檢一次**（綁進 `RELEASE_FLOW.md`）:逐條確認上游是否已修;修了就執行該條的「WHEN FIXED」並更新/移除該條。
> 目的是**消除搜尋成本**——不用 release 時跨各 `context/` topic 去翻「哪些上游要回檢」。

## 什麼該放 / 不該放

- ✅ **放**:上游 bug/限制**此刻正壓著我們一個能力、或迫使一個 workaround**,且「上游修了 → 我們會改 code / 回復能力 / 移除 workaround」。
- ❌ **不放**:
  - 上游限制逼我們**轉去一個刻意的替代方案、修了也不會 revert**。
    (例:`--add-dir` 對 skill 死掉 → 我們改走 config-home,並**同步把 auth 定位調成 device-scoped**;config-home 已成為 feature,就算 `--add-dir` 修了也不回頭 → **不追**。)
  - closed / won't-fix 的。
  - 純解釋「為什麼這樣設計」的 —— 那是 `context/<topic>.md` 的 gotcha,不是 watch-item。
- **單一真相**:「為什麼」的完整脈絡寫在對應的 `context/<topic>.md`;這個檔只放**連結 + 影響 + 現行決策 + 「修了要做什麼」**,不複製 rationale。

## Entry 格式
`- [<repo> #<n>](<url>) — <一行影響>. STANCE: <現行決策>. WHEN FIXED: <上游修了要做的事>. [→ context/<topic>#N]`

若能力 blocker 尚無精確對應的公開 issue / PR，不可拿相鄰議題冒充。暫用 official
release/source link，附 `TRACKER: no exact public tracker`；每次回檢先搜尋是否出現
正式 issue / PR，有就把 release/source link 換成 tracker，再照上面格式追。

## Watching

- [electron-userland/electron-builder #10028](https://github.com/electron-userland/electron-builder/pull/10028) — GitHub publisher cache 的並行初始化會讓同一個 platform build 建立重複 draft；上游修正已合併但尚未進 stable release。STANCE: workflow 在 matrix 前自動建立/重用唯一 draft，並暫留序列化 build。WHEN RELEASED: 升到包含此修正的 stable electron-builder，驗證 macOS artifacts 全部附著同一 draft，再移除 pre-create gate並重新評估 `max-parallel: 1`。 [→ context/build-packaging#8]
- [github/copilot-cli #1040](https://github.com/github/copilot-cli/issues/1040) — `copilot --acp` 靜默不載入經 `session/new` 傳入的 **stdio** MCP server(http transport 正常;Shelf 側已驗證 config 投影/轉換/傳送皆正確)。STANCE: **接受 regression**(copilot cutover 後使用者的 stdio custom MCP 失效;MCP 困擾 < skill,非 cutover blocker)。WHEN FIXED: 移除各處「accepted regression」註記 + 確認 stdio custom MCP 恢復;可省掉備案的「stdio→http wrap」workaround。
- [github/copilot-cli #4233](https://github.com/github/copilot-cli/issues/4233) — `copilot --acp` 不 emit ACP `usage_update` → agent status bar 對 copilot **沒有 `ctx` 段**(claude 有);資料 copilot 內部有算(`/context`、`/usage`、`statusLine.command`),只是沒透過 ACP 送。STANCE: **不顯示 ctx**(不做像 Zed 那種不準的自估,見 zed#44909;`translate.ts` 已有 `usage_update` handler,球在上游)。**AI-credit 已改走 SDK `account.getQuota`**(agent-providers#26),不再等此票。WHEN FIXED: ctx 自動亮(handler 現成)。 [→ context/agent-providers#25]
- [GitHub Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) — bundled Copilot ACP 以 `wait:false` 提前回覆 prompt、新 prompt 前會 abort 上一輪，並把 cancellation `session.info` 壓成 assistant text。TRACKER: no exact public tracker。STANCE: Autopilot 一般任務以 terminal `task_complete` gate idle/next prompt；agent advertise 的 slash command 不產生該 tool，以 prompt settlement 收尾。Copilot provider 另窄過濾精確的 `Info: Operation cancelled by user` adapter 產物。WHEN FIXED: 升級 pinned Copilot CLI，實測 prompt response 等到真正 session idle、連續 prompt 不再產生假 user-cancel chunk或 ACP 提供 authoritative session activity，再移除 completion gate、slash 例外、filter、常數與 regression tests。 [→ context/agent-providers#37, #48]
- [openai/codex #16028](https://github.com/openai/codex/issues/16028) — Codex `/mcp` 可能把已載入且可呼叫的 app-level / custom MCP 顯示成沒有 tools，slash card 因而不能作為 MCP 可用性的可靠判斷。STANCE: **接受顯示退化**；維持現有 app-server config 注入與 `tool_search` 能力，不因 `/mcp` 空清單停用 MCP。WHEN FIXED: 升級到含修正的 pinned `@openai/codex`，實測 app-level、custom、`shelf` MCP 的 server/tool 清單皆正確，再視 app-server response shape 更新 card formatter並移除此條。 [→ context/skills#3]
- [openai/codex releases](https://github.com/openai/codex/releases) + [app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) — Shelf 的 Codex Background Tasks integration 目前無法可靠啟用：app-server 缺 initial-yield 後的 authoritative background-promotion notification 與 final process-owner termination reason。STATUS: **TRACKING**。TRACKER: no exact public tracker；回檢時搜尋 app-server issue / PR。STANCE: production integration 暫停；不以 turn timing/list heuristic 猜 task、不維護 Codex binary fork，也不先交付不可 Stop 的殘缺 UI。WHEN AVAILABLE: pin實際 release並跑 promotion→foreground handoff→idle progress/final、Stop/exit race、output read、normal teardown/reaper 的 bounded live probe，全數通過後才恢復 implementation。
