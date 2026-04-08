# Release Flow

- Push tag `v*` triggers GitHub Actions build for macOS / Windows / Linux
- GitHub Actions creates a **draft release** with `generate_release_notes`
- Version bump commit message should serve as release notes, listing changes:

```
v0.x.x

- Feature/fix description
- Feature/fix description
```

- After build completes, review the draft release on GitHub and publish

## Steps

1. Update `version` in `package.json`
2. Commit with changelog as message
3. `git push origin main`
4. `git tag v0.x.x && git push origin v0.x.x`
5. Wait for GitHub Actions build
6. Review and publish draft release on GitHub
