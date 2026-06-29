---
type: context
title: Web Tab
related:
  - contracts/app-tool-bridge
  - contracts/ipc-channels
  - context/agent-providers
  - context/pm-agent
---

# Web Tab

> Web tab（登入 surface）+ agent `web.fetch`：讓 agent 用**使用者已登入的瀏覽器 session** 打公司內網 SSO 服務（Kibana/ArgoCD）。cookie 留在 main，agent 不碰。
> 渲染原語/provider 無感原則見 `agent-providers`；app_tool registry 見 `contracts/app-tool-bridge`。

## web-tab#1 — 網路身分跟 connection 走，不跟 renderer · [Decision]

**Background**：shelf 心智模型 = renderer 是顯示器，每個 tab 是「某 connection」的視圖（terminal=remote pty、agent=remote agent）。新增 web tab 時要決定它的網路出口屬誰。

**Decision**：
- **terminal / agent / web 都是同一 connection 的不同視圖**，共享該 connection 的網路出口。web tab egress 不該因為「畫面在本機渲染」就變成本機網路（否則同一視窗 terminal `curl kibana` 走 remote、web tab 走本機，破壞「terminal 連得到的 web 也連得到」的一致性）。
- **無法消除的拆分**：互動渲染 + 登入一定在本機 Chromium（remote headless 渲染不了 Azure 登入 + MFA）。但使用者感知的「網路」是可達性 + 身分,不是封包從哪張網卡出 → render 本機、egress 看工具邊界,不破壞體感。
- **兩工具 = 兩維度**（agent 怎麼選網路位置）：
  - **MCP `web.fetch`** = egress 永遠本機（main 執行）+ 帶登入 cookie 身分。
  - **bash/curl（agent 原生 tool）** = egress 在 agent-server 所在地（local→本機、remote→遠端）+ 裸的無 session。
  - agent 要哪一側 = 挑哪個工具,無需切換機制。tool description 就是路由邏輯（`WEB_FETCH_DESC`）：暴露**能力語意**（「這條帶你的登入身分」），不是機制（cookie/partition）。

**Do not change casually because**：別把 web tab egress 改成 renderer 本機網路——那會讓「網路」對同視窗不同 tab 意思不同。

**Related**：`src/main/web-session.ts`、`agent-server/app-tool-tools.ts`（`WEB_FETCH_DESC`）。

## web-tab#2 — web.fetch gate 在 main `handleAppTool`，不在 `canUseTool` · [Decision]

**Problem**：web.fetch 要 per-origin 授權。第一版把 gate 放在 main 的 agent permission callback（`canUseTool`），重用 `AGENT_PERMISSION_REQUEST` + `DecisionPanel`，但這違反 `agent-turn` 的「wire 只帶渲染原語、renderer 不得 if-this-tool 分支」（DecisionPanel 出現 `if web` 變體、permission payload 帶 web meta），且把 gate 綁進 provider-specific 的 permission 形狀 → Claude（per-tool name）與 Copilot（per-kind）行為分歧。

**Decision**：gate 放在 **`handleAppTool('web.fetch')`**（`src/main/agent/app-tool.ts`）——兩 provider 都經 `callMain('web.fetch')` 匯流到這個**單一 provider-agnostic 窄口**。
- permission 走**自有的 web-permission channel**（`src/main/web-permission.ts`：`requestWebPermission(meta)` → `WEB_PERMISSION_REQUEST` IPC → renderer app 層全域 popup `WebPermissionPrompt.tsx` → `WEB_PERMISSION_RESOLVE`）。跟 agent timeline / DecisionPanel **完全脫鉤**（重用 `SelectionPanel` 純元件,但不走 agent permission plumbing）。
- 兩 provider 只做一件 trivial 的事:**`browser_fetch` 跳過 provider 層提示**（claude `canUseTool` 對 `isWebFetchTool(toolName)` 直接 allow、copilot `defineTool(..., {skipPermission:true})`）,避免雙重提示。工具命名為 `browser_fetch` 而非 `web_fetch`:Claude SDK 內建了同名 `web_fetch`,外部工具撞名會直接報錯;且語意不同（內建 `web`=匿名抓公網、本工具 `browser`=帶你瀏覽器分頁的登入 session）。
- **連帶解掉三件事**：① Claude/Copilot 一致（gate 不依賴 provider permission 形狀,copilot 也拿到 origin 防偽 popup + grant）;② **bypass 模式自動 gate**（bypass 只讓 provider 跳過 tool 提示,但 tool 仍執行到 handleAppTool → gate 照常,不需 provider 特例）;③ renderer 無 tool 語意分支。
- **projectId 串接**（grant key 要）：`AgentView` opts → `AGENT_INIT` → `createRemoteBackend` → `spawnAgentServer` → `wrapProcess` → app_tool ctx `{projectId}`。**不放 agent SessionInstance**。

**Do not change casually because**：別把 web.fetch 的授權搬回 `canUseTool` / `AGENT_PERMISSION_REQUEST`——那是 provider-specific 且會讓 renderer 重新依工具語意分支。資源層授權就放資源層窄口。

**Related**：`web-tab#3`、`src/main/agent/{app-tool,index,remote}.ts`、`src/main/web-permission.ts`、`src/renderer/components/WebPermissionPrompt.tsx`、`agent-server/providers/{claude,copilot}/index.ts`。

## web-tab#3 — per-origin grant 安全模型 · [Decision]

**Problem**：`persist:web` 是**單一共用 cookie jar**(login once、跨 project),又選了**完整可瀏覽 web tab**(會登入各種站)。若 agent `web.fetch` 能無條件騎 jar 打任意 URL,被 prompt injection 後 = 拿著使用者全套 web 身分的代理人(以你身分讀/POST/打 admin)。

**Decision**：
- **預設 deny + 每 origin 提示**；`allow once`（不留記錄）/ `allow always`（寫進 grant whitelist,until revoked）。`deny` 丟錯給 agent。
- **grant key = `(projectId, origin)`**，**per-project**（least privilege）。session/cookie 是全域（網路身分,你登一次）、grant 是 per-project（把身分**逐一委派**給某 project 的 agent）——這個不對稱是對的：被注入的 agent 只能濫用**自己 project 授權過的** origin。grant 存 `projects/<id>/web-grants.json`（`src/main/web-grants.ts`）。
- **origin 防偽（最易漏）**：grant key 與提示顯示都用 **`new URL()` 權威解析的完整 origin `scheme://host[:port]`**（`parseHttpOrigin`,`src/main/web-session-helpers.ts`）——它剝掉 userinfo（`https://kibana.corp@evil.com`→`evil.com`）、IDN 轉 punycode。**永遠不顯示 agent 給的原字串**；grant key 用完整 host 不用 registrable domain（後者會讓 `kibana.corp.com` 連帶放行 `argocd.corp.com`）。tldts 的 registrable domain **僅供顯示** highlight。
- **session 清單 / grant whitelist UI** 在 Settings → Web（`WebSettingsTab.tsx`）:列已登入站(可刪/登出)、grant 按 project 分組(可 revoke)。session 清單是 hygiene **不是** access control——access 邊界是上面的 permission gate。
- **不做過期啟發式**：`web.fetch` 回**原始 `{status, headers, body}`**,不解讀「是否過期/未登入」（沒登入在 wire 上無可靠訊號:401/400/302/200+登入頁各家不同,硬猜會誤判）。結果交 agent/使用者判斷（`WEB_FETCH_DESC` 引導 LLM 看回應判斷）。`redirect:'manual'` 不跟隨**保留**（安全:granted origin 不把 cookie 帶去 redirect 目標;3xx 原樣回 status+Location）。

**Do not change casually because**：
- 別把 grant key 放寬成 registrable domain 或全域跨 project（破壞 least privilege / 防偽）。
- 別在 renderer 重建「事前 allowlist」取代 permission gate——session 清單只能事後刪,擋不住 agent 在你刪之前已用過。
- 別加回過期啟發式 / 自動開登入頁——不可靠判斷觸發 UI 副作用是過度設計。

**Related**：`web-tab#2`、`web-tab#4`、`src/main/web-{grants,session,session-helpers}.ts`、`src/renderer/components/settings/WebSettingsTab.tsx`。

## web-tab#4 — webview hardening（全在 main） · [Decision]

**Problem**：web tab 嵌入**不受信任的任意網頁**且共用敏感 cookie jar → 當敵意沙箱頁處理。renderer 不能被信任去 harden 自己。

**Decision**（`src/main/web-session-harden.ts`,startup 經 `app.on('web-contents-created')` 單一全域 hook,涵蓋所有視窗含 macOS reactivate）：
- **強制安全 webPreferences**（`will-attach-webview`）：刪 `preload`、`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`——即使 `<webview>` 屬性被誤設也覆寫。web 內容絕不能拿到 `shelfApi` preload 或 Node。
- **彈窗/新視窗全 deny**（`setWindowOpenHandler`）。popup-OAuth 之後要再對已知 IdP origin 加白名單;v1 全擋。
- **導航限 http(s)**（`will-navigate`/`will-redirect` + `parseHttpOrigin`）：擋 `file://`/`javascript:`/自訂協定;一般瀏覽仍自由。
- **裝置權限全 deny**（`setPermissionRequestHandler` + `setPermissionCheckHandler`）、**下載全擋**（`will-download`）。
- **不削弱既有防線**：憑證保持預設拒絕無效（**不加** `certificate-error` handler）、`webSecurity` on。

**Do not change casually because**：hardening 是輔助;主防線是 `web-tab#3` 的 permission gate。但別在 webview 開 nodeIntegration / 設 preload / 盲信憑證。

**Related**：`src/main/{web-session-harden,index}.ts`（`webviewTag:true` + wiring）、`WebTabView.tsx`。

## web-tab#5 — web-permission 的 away 路由 + timeout backstop · [Decision]

**Problem**：`web.fetch` 的 permission popup 是阻塞的（bridge tool await）。使用者不在時若無人答 → agent turn 永久 hang。原則:所有 popup 在 away 都該轉 Telegram。

**Decision**（`src/main/web-permission.ts`）：delivery 是 **pending request 的屬性,不是出生時 one-shot**。
- 永遠開桌面 popup;**Away 時同時送 Telegram inline button**;**Away 中途開啟也補送**（訂閱 `onAwayModeChange`,`src/main/pm/away-mode.ts`）。
- **single resolver, first-answer-wins**：任一 channel 先答即贏,另一邊撤回（桌面發 `WEB_PERMISSION_CLOSE` 關 popup、Telegram editMessageReplyMarkup 清空）。
- **timeout backstop**：5 分鐘無人答 → fail-closed deny（loud log），不永久 wedge。
- Telegram 端用**通用 `sendInteractivePrompt(text, options, onAnswer)` + `cancelInteractivePrompt`**（`src/main/pm/telegram.ts`,callback_data `ip:<promptId>:<value>`）——非 web 專屬,為未來 agent permission/picker 共用同一 transport 鋪路。

**Open**：完整共用 prompt 路由層（把既有 agent permission/picker 也接上 `sendInteractivePrompt`）尚未做——目前只 web-permission 用,agent permission 仍是 telegram notify-only fallback（見 `pm-agent`）。transport 已備妥,只差接過去。

**Related**：`src/main/{web-permission,pm/telegram,pm/away-mode}.ts`、`WebPermissionPrompt.tsx`。

## web-tab#6 — cookie jar：必 `useSessionCookies`，但不主動延長 session 壽命 · [Decision + Gotcha]

**Gotcha（必修）**：`browser_fetch`（main `webFetch`，`src/main/web-session.ts`）的 `net.request` **一定要 `useSessionCookies: true`**。Electron 的 `net.request` 預設**不送 session cookie**——少了它,即使使用者在 web 分頁登入了,每個 authed request 仍回 401（实测 Kibana `/api/spaces/space` 401→200 就差這個）。這就是 `browser_fetch`（騎登入身分）相對內建 `web_fetch`（匿名）的全部意義。

**持久化現況**：`persist:web` 是持久化 partition，**有 `Max-Age`/`Expires` 的 cookie 會自動跨 app 重啟存活**（Chromium 還原），完全免 code。**但 session cookie（無 expiry，如 Kibana 的 `sid`）Chromium 啟動時不載回** → 那類服務的登入態不跨重啟,使用者要重新登入。

**Decision（刻意不做）**：**不**實作「跨重啟還原 session cookie」。服務把 cookie 設成 session（關閉即失效）是它**刻意的安全意圖**;我們主動把它撐過重啟 = 替使用者延長別人設計的短命 session = 越權。尊重來源服務的生命週期,讓使用者重新登入即可。用 persistent cookie 的服務本來就跨重啟存活,不受影響。

**Do not change casually because**：別為了「方便」加回 session-cookie 還原機制——那是越權延長敏感 session,不是 bug。`useSessionCookies` 則相反,是必要的、不可拿掉。

## web-tab#7 — default tab 可指定 web kind（連線時自動開 web 分頁） · [Decision]

**Background**：`defaultTabs`（project config）原本只開 terminal。要讓 project 連線時自動帶起常用的 web 分頁（如 Kibana）。

**Decision**：`TabTemplate` 加 `kind?: 'terminal' | 'web'`（**absent = terminal**，舊 config 不動）+ `url?`（web 起始網址，optional）。
- **持久化形狀刻意 disjoint**：terminal template 帶 `cmd`、**不寫 `kind`**（與既有 config byte-identical，零 migration）；web template 帶 `kind:'web'` + optional `url`、**永不帶 `cmd`**（`ProjectEditPanel.handleSave` 正規化）。
- **連線開 tab**（`App.tsx`）：`t.kind === 'web'` → `addTab(..., 'web', undefined, t.url)`，否則照舊開 terminal。
- **label pin**：`addTab` 對**有具名的 web tab** 設 `labelPinned`（使用者在 default tab 取的名字不被導航的 host 蓋掉）；手動 `+ Web`（無名）仍跟 host 走。
- **UI**：`+ Add Tab` 拆成 `+ Add Terminal` / `+ Add Web` 兩顆；每列一個唯讀 kind chip（`sh`/`web`）區分；web 列第二欄是 URL input 而非 command。Quick command target 下拉**排除 web tab**（web 不能跑 shell command）。

**Do not change casually because**：別給 terminal template 補寫 `kind:'terminal'`（會讓所有舊 config 無謂 churn）；kind 缺省即 terminal 是刻意的 back-compat 契約。

**Related**：`src/shared/types.ts`（`TabTemplate`）、`src/renderer/store.ts`（`addTab` url/labelPinned）、`src/renderer/App.tsx`（連線分流）、`src/renderer/components/ProjectEditPanel.tsx`。
