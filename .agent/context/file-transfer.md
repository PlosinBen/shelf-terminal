---
type: context
title: File Transfer
related:
  - architecture/terminal-io
  - context/connector
  - context/terminal-pty
---

# File Transfer

> Paste / drag-drop 檔案上傳：統一走 `<cwd>/.tmp/shelf/`、cat-via-stdin、session-based 清理；含事件攔截 phase 與檔名 prefix 解析的雷。

## file-transfer#1 — 檔案上傳統一走 `<cwd>/.tmp/shelf/`，不用 `/tmp/shelf-paste`  ·  [Decision]

**Decision**：所有 paste / drag-drop 上傳的目的地都是 `<projectCwd>/.tmp/shelf/<prefix>-<filename>`，而不是過去的 `/tmp/shelf-paste/`。Local / SSH / Docker / WSL 共用同一個 `connector.uploadFile` 入口。

**Reason**：
- 沙盒過的 agent CLI（Claude Code、Gemini、Codex）只能讀 project 內的檔案，丟到 `/tmp` 它會回 permission denied。
- 路徑跟著 project 走，不會在 `/tmp` 留下跨 project 的孤兒檔。
- `.tmp/` 慣例上 git-ignorable，使用者可以一鍵清掉。

**Do not change casually because**：換回 `/tmp` 會直接打破 sandboxed agent 的使用情境。

## file-transfer#2 — 上傳一律 cat-via-stdin，不用 scp / docker cp  ·  [Decision]

**Decision**：SSH / Docker / WSL 三種 transport 在 `file-transfer.ts` 都用同一個 pattern：
`spawn('<bin>', [...args, 'sh', '-c', "mkdir -p '<dir>' && cat > '<path>'"])` 然後把 buffer 灌進 stdin。

**Reason**：
- **不用 staging file** — 不再需要先寫 `os.tmpdir()/shelf-paste/xxx` 再傳出去，也不會有 staging 漏掉沒清的問題。
- **不用 scp 的 remote-shell 解析** — scp 在遠端會把路徑跑過一次 shell，filename 含空白／引號就會炸；改用 `cat >` 後路徑只經 single-quote 一層。
- **三種 transport 對稱** — 同一個 helper（`spawnPipeWrite`）三邊複用，新增 transport 只要再寫一個 wrapper。

**Do not change casually because**：退回 scp 會把 staging cleanup、cross-shell quoting、binary safety 三個雷一次踩回來。

## file-transfer#3 — 上傳清理：session-based、cutoff 從檔名解出來  ·  [Decision]

**Decision**：`<cwd>/.tmp/shelf/` 清理走兩條路：
- **自動**：project 在 Shelf process 內第一次 spawn pty 時，`maybeScheduleCleanup()` 排 3 秒後 fire-and-forget cleanup。同 project 在 process 內只跑一次（`cleanedProjects` Set 去重）。Cutoff 是 `SESSION_STARTED_AT`（process 啟動時 ms），比這個舊的刪。
- **手動**：ProjectEditPanel 的 Clear 按鈕無視時間戳直接清空。

過期判斷從**檔名解出**：upload prefix 是 `Date.now().toString(36) + counter`，`parseUploadPrefix()` 反解回 ms，不依賴 mtime。

**Reason**：
- `find -mmin` 解析度是「捨入到下一分鐘」，會誤刪剛 paste 的檔。Filename-encoded ts 精確到 ms
- 四種 transport 只需要 `ls` + `rm`，不需要 `find` / `stat`
- `parseUploadPrefix` 對非 Shelf prefix 回 `null`，user 自己的檔不會被掃
- Fire-and-forget + 3 秒延遲讓 first paint 不被 cleanup 卡到，錯誤只 log 不 throw

**Do not change casually because**：
- 換回 mtime cutoff → 踩 `find -mmin` 捨入問題
- Cleanup `await` 在 spawn 之前 → 遠端 exec 延遲直接打到開 tab 時間
- 拿掉 dedupe → 每次 spawn 都重跑 cleanup，浪費 SSH/docker exec

## file-transfer#4 — 檔案上傳 mkdir + cat 串在同一個 sh -c  ·  [Gotcha]

**Symptom**：在 `file-transfer.ts` 把 `mkdir -p` 和 `cat >` 拆成兩次 ssh / docker exec 呼叫時，有時候 race 到 cat 看不到目錄。

**Root cause**：兩次獨立的遠端 exec 不保證順序，cat 可能在 mkdir 之前抵達遠端。

**Fix**：一律用 `sh -c "mkdir -p '<dir>' && cat > '<path>'"`，目錄建立和寫入在同一個遠端 shell 內順序執行。`mkdir -p` 本身就 idempotent，目錄已存在不會錯。路徑用 `shellSingleQuote` 包起來，遠端 shell 不會二次解析任何字元；若改回呼叫 `execFile` 走 scp/docker cp，就要重新處理跨 shell 的 quoting。

## file-transfer#5 — Paste 使用 Capture Phase 攔截，Drop 使用 Bubble Phase  ·  [Gotcha]

**Symptom**：檔案 paste 沒反應。

**Root cause**：xterm 的 `xterm-helper-textarea` 攔截 paste event 後不會冒泡到 container。必須用 capture phase（`addEventListener` 第三參數 `true`）在 xterm 之前攔截。Drop 不需要 capture phase 因為 xterm 不攔截 drop 事件。

**Fix**：
- Paste：clipboard 含有 `kind === 'file'` 的 item 就走上傳；若同時帶 `text/html`（從瀏覽器複製富文本，image 只是 favicon）則放行讓 xterm 當文字貼上。
- Drop：`dataTransfer.files` 非空就走上傳，不檢查 MIME（任何檔案都收）。

## file-transfer#6 — parseUploadPrefix 必須卡長度 + 時間範圍，不然會誤刪使用者檔  ·  [Gotcha]

**Symptom**：Session cleanup 把使用者自己丟進 `.tmp/shelf/` 的檔（例如 `manually-placed.log`）也刪掉了。

**Root cause**：早期版本的 `parseUploadPrefix()` 只檢查「是不是 `[a-z0-9]+-...`」就接受。`manuall`（取 prefix 去掉最後一個 counter char）剛好是合法 base36，`parseInt('manuall', 36)` ≈ 48 億 ms，遠小於現在的 `Date.now()`，於是被歸類為 stale 然後刪掉。

**Fix**：在 `file-transfer.ts` 的 parser 裡同時要求：
1. `prefix.length >= 9` — 真實的 Shelf prefix 是 8 字元 base36 timestamp + 1 counter char，1972~2059 都是 9 字元。
2. 解出來的 ms 落在 `[2020-01-01, 2100-01-01)` 這個 sanity window。

第二個 floor 同時擋掉「9 字元但解出來變 1995」的字（例如 `aaaaaaaaa`）。如果以後要改 prefix 格式，這兩個 guard 都要同步調整，並補上 regression test（`file-transfer.test.ts` 已經有 `manually-placed.log` 跟 `aaaaaaaaa` 兩個 case）。
