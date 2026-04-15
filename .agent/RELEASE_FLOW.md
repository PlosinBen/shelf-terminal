# Release Flow

## Steps

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
