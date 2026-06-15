# PRODUCT — Shelf 設計守則

> 這份文件是 **設計決策的對齊守則**：設計新功能、評估取捨、判斷 feature
> 是否該做時，先回來對齊這裡列的原則。

---

## 1. 核心穩定、附加可換

**Project-based terminal 集中管理是核心、其他都是附加**。核心 API /
資料結構 / UX 流程不會輕易動；附加功能可以長、可以縮、可以換實作，
但不能反過來綁架核心。

| 層級 | 功能 | 定位 |
|------|------|------|
| **核心** | Project-based tab/session 管理、跨環境 terminal (local/SSH/Docker/WSL) | Shelf 的存在理由 |
| **附加** | Agent view (Claude / Copilot)、PM Agent、Notes、DevTools、Worktree、Telegram bridge | 順手加上去的工作流增強 |

判斷某個新 feature 該不該做時，先問「這是在加強 terminal 集中管理嗎？
還是在偏離核心？」

## 2. 不做超出定位的事

定 scope 的原則是 **「從真實工作流出發」**：feature 要對應到具體、
常用的使用情境才做，不是「看起來該有」就加。沒人實際在踩的痛不解，
工作流上真的痛的事即使小眾也值得做。

**唯一一條無條件的硬邊界：Shelf 不會想取代 IDE / Editor。** Shelf 替
代的是 tmux 那層（terminal session 管理），不是 VS Code / JetBrains
那層。

具體拒絕清單：
- ❌ 內建 code editor / file tree / debugger
- ❌ LSP / go-to-definition / refactor 之類 IDE 功能
- ❌ 取代 IDE 成為 primary coding surface

其他方向（web 版、多人協作、商業化、Windows native...）目前無明確立
場，等真的有使用情境再評估。

## 3. 跨環境一視同仁

**Local / SSH / Docker / WSL 都是一等公民**，不是「local 為主、遠端
湊合」。開發者跨 macOS / Windows (WSL) daily 用，遠端執行 agent 是常
態而不是 edge case，所以跨環境一致性是設計門檻而不是 nice-to-have。

## 4. 使用者環境零依賴（長期目標）

裝 Shelf installer 就能用，不要求使用者額外裝 Node / Python / CLI
工具。例外只有 provider auth（要使用者自己登入 Claude / GitHub）。

新依賴進 codebase 之前先問「使用者需不需要為這個東西多裝什麼？」
如果是，預設要 bundle / 自帶 / lazy download，不要丟給使用者。

## 5. 原生的歸原生，Shelf 的歸 Shelf

Claude / Copilot **原生支援**的能力（project-level skills、MCP discovery、
instruction files、slash…），Shelf 預設**盡量打開、照原生行為走**，讓「用
原生 CLI」和「用 Shelf agent view」體驗一致、甚至更好，不給降級體驗。連帶
行為（如 project 的 MCP 自動載入）是 native parity 的一部分、不是 bug。

更關鍵的是**責任歸屬要清楚 —— 出問題該查誰**：

| 層級 | 由誰定義 | 出問題查 |
|------|----------|----------|
| **Project 層**（`.claude/`、`.agents/`、`.mcp.json`…） | **官方**（Claude / Copilot） | 官方 docs / 行為 |
| **App 層**（跨 project、跨兩家的 skill / MCP…） | **Shelf** | Shelf |

**Shelf 不介入 project 層的機制**：硬去改寫/橋接官方的 project-level 行為
（例：把 `.claude/skills` 餵給 copilot 做「跨兩家共用」），等於把官方的責任
攬上身、造成行為與支援的混亂。跨 project / 跨 provider 的統整是 **App 層**
（Shelf 加值）的事，疊在原生之上，**不取代、不改寫原生**。
