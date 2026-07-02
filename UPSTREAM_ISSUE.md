# Upstream Issues

> **這裡收的不是我們的 bug backlog，而是「受制於第三方套件、無法在自家 code 根治」的限制。**
> 每條的共同特徵：問題根因在依賴（xterm.js / Claude SDK / …）內部，我們只能等上游修或在自家繞。
> 每條必須有：**現象 → 上游 ref → 我們現況（純等升版 / 有 workaround 在哪）→ 移除觸發點**。
>
> 分工：**有自家 code workaround 的**（那段看起來像 bug、會被誤改），主檔在 `.agent/context/` 留 gotcha 保護 code，這裡只留一行「移除觸發點」互相指；**純等升版、自家零 code footprint 的**，只記在這。
> 上游修好、觸發點達成後，回來刪掉對應條目（連同 `context` 的 workaround）。

---

## xterm.js — Windows 中文 IME 浮動框位置異常

**現象**：Windows 上使用中文輸入法時，IME 候選框有時會跑到畫面最右側。特別在 shell 顯示 placeholder/hint 文字（如自動補全提示）時容易觸發。

**原因**：xterm.js 的 `.xterm-helper-textarea` 在 composition 開始時未正確同步游標位置，導致 IME 候選框定位到 placeholder 文字尾端。

**上游 Issue**：[xtermjs/xterm.js#5734](https://github.com/xtermjs/xterm.js/issues/5734)

**我們現況**：純等升版，自家沒有 workaround code。目前 `@xterm/xterm` 6.0.0。

**移除觸發點**：已由 [PR #5759](https://github.com/xtermjs/xterm.js/pull/5759) 修復，目前僅在 `@xterm/xterm` 6.1.0-beta。**等 6.1.0 正式版發布後升級即解**，升級後刪除本條。

---

## Claude Agent SDK — `rate_limit_event` 正常態不暴露 `utilization`

**現象**：Claude 的 status bar quota 段平常只顯示 bucket 名稱 + reset 倒數（`5h: — ↻3h`），拿不到真正的配額百分比；只有配額快爆（`allowed_warning`）或已擋（`rejected`）時才會出現 `%`。

**原因**：SDK 的 `SDKRateLimitInfo.utilization` 只在 `status === 'allowed_warning' | 'rejected'` 才有值，正常的 `'allowed'` 態被 SDK 靜默丟掉——即使底層 `anthropic-ratelimit-unified-*-utilization` HTTP header 一直帶著這個數字。

**上游 Issue**：[anthropics/claude-code#50518](https://github.com/anthropics/claude-code/issues/50518)（請求對 headless SDK consumer 暴露 per-bucket rate-limit utilization）。

**我們現況**：**有 workaround**——`claude/helpers.ts` 的 `rateLimitInfoToSegment` 在沒有 `utilization` 時 render `—` fallback（保留 bucket + reset countdown）。詳細與「別誤改」的保護見 `.agent/context/agent-providers.md` 的 `agent-providers#7`。

**移除觸發點**：#50518 落地（SDK 在正常態帶 utilization）後，移除 `—` fallback、改讀真值，並刪除 `agent-providers#7` 與本條。
