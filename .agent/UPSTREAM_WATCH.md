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

## Watching

- [github/copilot-cli #1040](https://github.com/github/copilot-cli/issues/1040) — `copilot --acp` 靜默不載入經 `session/new` 傳入的 **stdio** MCP server(http transport 正常;Shelf 側已驗證 config 投影/轉換/傳送皆正確)。STANCE: **接受 regression**(copilot cutover 後使用者的 stdio custom MCP 失效;MCP 困擾 < skill,非 cutover blocker)。WHEN FIXED: 移除各處「accepted regression」註記 + 確認 stdio custom MCP 恢復;可省掉備案的「stdio→http wrap」workaround。
- [github/copilot-cli #4233](https://github.com/github/copilot-cli/issues/4233) — `copilot --acp` 不 emit ACP `usage_update` → agent status bar 對 copilot **沒有 `ctx` 段(及 cost/AI-credit)**(claude 有);資料 copilot 內部有算(`/context`、`/usage`、`statusLine.command`),只是沒透過 ACP 送。STANCE: **不顯示**(不做像 Zed 那種不準的自估,見 zed#44909;`translate.ts` 已有 `usage_update` handler,球在上游)。WHEN FIXED: ctx 自動亮(handler 現成);為 AI-credit 加一段讀 `usage_update._meta` map 成 status segment。 [→ context/agent-providers#25]
