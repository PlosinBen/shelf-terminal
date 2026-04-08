# Release Flow

## Steps

1. Run `git log <last-tag>..HEAD --oneline` to get actual changes since last release
2. Update `version` in `package.json`
3. Write commit message based on the git log output (not memory), listing only changes in this release
4. Commit, push, tag, push tag:
   ```bash
   git add package.json
   git commit -m "v0.x.x ..."
   git push origin main
   git tag v0.x.x && git push origin v0.x.x
   ```
5. Wait for GitHub Actions build
6. Review and publish draft release on GitHub

## Commit Message Format

```
v0.x.x

- Change description (from actual git log)
- Change description
```

## Important

- **Never write release notes from memory** — always `git log <last-tag>..HEAD` first
- GitHub Actions creates a **draft release** with `generate_release_notes`
- Version bump commit message serves as the primary release notes
