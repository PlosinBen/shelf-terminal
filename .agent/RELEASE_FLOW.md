# Release Flow

> ⛔ **禁止自主發版**。版號 bump、commit release note、push tag、觸發 release workflow —— 這些動作**一律等使用者明確要求(例如「發 2.x.y」「release」)才執行**。即使測試全綠、即使修了 blocker、即使「看起來就差發版」,也**不要自己 bump / tag / push**。可以做好前置(寫 code、測試、commit 到 branch/main)並**告知已就緒、詢問是否發版**,但發版的板機由使用者扣。

## Steps

0. **先同步 + 核對 origin 狀態(commit + tag),再決定範圍**。本機 tag / branch 可能落後 origin —— 若漏了某個 tag,`git describe` 會抓到**更舊的 last-tag**,release note 範圍就會多含已發布的內容(2.11.0 就這樣多列了 2.10.0 的功能)。發版前一律:
   ```bash
   git fetch origin --tags        # 補齊 origin 上但本機沒有的 tag
   git tag --sort=-v:refname | head -3           # 確認最新 tag 真的是 last-tag
   git log --oneline origin/main..HEAD           # 確認要發的 commit 都在、且 main 領先 origin（不是落後）
   ```
   `git describe --tags --abbrev=0` 抓到的 last-tag 必須跟「origin 上真正最新的 release tag」一致才往下走。
0.5. **每天第一次發版時，先跑一次 `npm audit`**（安全掃描）。頻率綁「當天第一次」而非每次發版：同一天內依賴版本不會變，後續發版可略過；有跨天再查。
   - **high / critical**（尤其打包進 app 的 runtime 依賴）→ 先處理（升版 / `npm audit fix` / 必要時 `overrides`）再往下發，不要帶著已知漏洞出貨。
   - 無，或只剩 low / moderate 且僅影響 build/dev 工具鏈 → 記錄後放行。
   - ⚠️ `npm audit` 只涵蓋「有登記 advisory」的漏洞。**Electron 的 Chromium-CVE 安全版通常不在其內**（CVE 掛在 Chromium tracker、發在 Electron blog，不以 npm advisory 形式掛在 `electron` 上）；要確認 Electron 是否有安全 patch，需另行看 Electron releases（同 major 的新 patch ≈ CVE backport）。
1. Run `git log <last-tag>..HEAD --oneline` to get actual changes since last release
2. Update `version` in `package.json`
3. Write commit message based on the git log output (not memory), listing only changes in this release
4. Commit, push, tag, push tag:
   ```bash
   git add package.json
   git commit -m "$(cat <<'EOF'
   vX.X.X

   - feat: ...
   - fix: ...

   Co-Authored-By: <model name> <noreply@anthropic.com>
   EOF
   )"
   git push origin main
   git tag vX.X.X && git push origin vX.X.X
   ```
5. GitHub Actions 自動 build 三平台（mac/win/linux），建立 **draft** release
6. 使用者在 GitHub 上 review draft，手動 publish

## Commit Message Format

Title = 版本號，body = release note（英文）。

```
vX.X.X

- feat: short description
- fix: short description
- refactor: short description

Co-Authored-By: <model name> <noreply@anthropic.com>
```

只列 feat / fix / refactor 等使用者可感知的變更，省略 docs / chore。
文件變更可以包含在 release commit 中，但功能變更不行。

## Versioning

使用語意化版本（Semantic Versioning）：`MAJOR.MINOR.PATCH`

- **MAJOR** — 不相容的 API / 行為變更
- **MINOR** — 新增功能（向下相容）
- **PATCH** — bug fix、UI 微調（向下相容）

## Important

- **Never write release notes from memory** — always `git log <last-tag>..HEAD` first
- `package.json` version 必須與 tag 一致，否則 electron-builder 不會建立對應的 GitHub Release
- Version bump + release note 合在同一個 commit，tag 打在該 commit 上
- GitHub Actions 由 tag push 觸發 build，產出 draft release
- **Tag push 出去後視為不可變 —— 絕對不要移動 / 覆蓋既有 tag**。remote 對 tag 有 ref protection（刪除/重建要 admin bypass，且會重觸發一輪 build、留下混亂歷史）。build 失敗時：修好問題，**bump 下一個 patch 版號重發**（例：v2.6.1 build 掛 → 修完發 v2.6.2），失敗的 tag 原地留著即可，不用回收。
