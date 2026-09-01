---
type: contract
title: Persistence Formats
related:
  - context/storage
  - context/settings-config
  - context/deployment
  - contracts/process-memory
---

# Persistence Formats

The on-disk artifacts Shelf persists and their layout. Two roots: `<userData>` (Electron per-install dir — the client's source of truth; `-dev` suffix when unpackaged, see `context/settings-config`) and `~/.shelf/` (per-machine server data, addressed via `os.homedir()` so agent-server resolves it identically local or remote, see `context/deployment`). For authoritative shapes this names the source file + TypeScript type rather than duplicating field lists.

## `<userData>/projects.json`

- **Path**: `<userData>/projects.json`
- **Current format**: pretty-printed versioned envelope. Authoritative persisted DTO and validation live only in `src/main/projects/project-config-codec.ts`.

  ```json
  {
    "schemaVersion": 1,
    "projects": [
      {
        "id": "opaque-id",
        "name": "Example",
        "cwd": "/repo/example",
        "connection": { "type": "local" },
        "maxTabs": 5,
        "initScript": null,
        "envPlain": {},
        "defaultTabs": [],
        "quickCommands": [],
        "featureNoteDir": null,
        "parentProjectId": null,
        "worktreeBranch": null,
        "baseBranch": null,
        "defaultAgentProvider": null,
        "openAgentOnConnect": false,
        "agentSessionIds": {},
        "agentPrefs": {}
      }
    ]
  }
  ```

- **Compatibility**: an unversioned array is supported legacy v0. Loading either v0 or v1 produces the same canonical `Project[]`; load is read-only. The next successful project mutation formats v1 naturally. Malformed data, duplicate ids, wrong shapes, or unsupported versions fail all-or-nothing.
- **Source of truth**: `src/main/projects/project-config-{file-io,codec,persistence}.ts`. Missing file → canonical `[]`; an existing zero-byte file is malformed, not missing. Writes use same-directory temp + atomic replace. Before a nonempty persisted collection is replaced by canonical empty, the original opaque file is copied to `projects.json.backup.<timestamp>`.
- **Provider compatibility**: `defaultAgentProvider`, `agentSessionIds`, and `agentPrefs` retain unknown old/future provider ids; runtime consumers resolve behavior through the live registry.
- **Agent preference values**: each `agentPrefs[provider]` is an `AgentPrefs` object defined in `src/shared/types.ts`: `{ model?: string, effort?: string, permissionMode?: string, nativeMode?: string, nativePermission?: string }`. The codec accepts only string values for present fields and preserves unknown provider keys. `permissionMode` belongs to Shelf-strategy controls; `nativeMode` and `nativePermission` hold confirmed values for a provider-advertised native strategy. Capability confirmation writes present values without deleting a saved field merely because a later capability snapshot omits that control.

## `<userData>/settings.json`

- **Path**: `<userData>/settings.json`
- **Format**: JSON object, pretty-printed (2-space). Shape is `AppSettings` (`src/shared/types.ts`) — `fontSize`, `fontFamily`, `themeName`, `scrollback`, `keybindings: KeybindingConfig`, `logLevel`, `pmProvider`, `telegram`, `pmActive`, etc.
- **Source of truth**: `src/main/settings-store.ts`. On load it is **shallow-merged over `DEFAULT_SETTINGS`** (`src/shared/defaults.ts`), with `keybindings` additionally deep-merged, so a stored file may omit keys added in newer versions. Missing file → defaults (see `context/settings-config` settings-config#2).

## `<userData>/logs/{mem,mem-summary}/YYYYMMDD.log` — retained memory diagnostics

- **Paths**: `<userData>/logs/mem/YYYYMMDD.log` and `<userData>/logs/mem-summary/YYYYMMDD.log`, using local calendar dates.
- **Line format**: `<writer ISO timestamp> [<LEVEL>][<tag>] <JSON payload>`; one append-only record per line.
- **`mem` payload**: `MemorySourceRecord` from `src/main/process-memory-manager.ts` — `{ receivedAt, sourceId, source?, accepted, reason?, report }`. Successful `report` values contain every attributed process row; failed and rejected attempts remain explicit records.
- **`mem-summary` payload**: the exact `ProcessMemorySummary` object cached for hydration and pushed to renderer on that 30-second tick. Its authoritative shape is `src/shared/process-memory.ts`; see `contracts/process-memory`.
- **Retention**: both named channels keep 30 days. `src/shared/channel-log.ts` owns the policies; `src/main/channel-log.ts` owns daily rotation and cleanup at initialization and the first write of each new day.

## `<userData>/projects/<projectId>/` — per-project dir

- **Path**: `<userData>/projects/<projectId>/`
- **Source of truth**: `src/main/project-storage.ts` (`projectDir(id)` / `ensureProjectDir(id)` / `removeProjectStorage(id)`). All per-project artifacts live here so project deletion is a single `fs.rm` (see `context/storage` storage#1). `<projectId>` matches the `id` in `projects.json`.
- **Format**: a file tree —

  ```
  projects/<projectId>/
  ├── pm-note.md            ← PM agent per-project note (plain markdown)
  ├── notes/<noteId>.md     ← user-facing notes, one file per note (frontmatter, below)
  └── images/<uuid>.<ext>   ← note image attachments (png/jpg/jpeg/gif/webp/bmp)
  ```

  - `pm-note.md`: opaque plain-markdown string. Source: `src/main/pm/note-store.ts` (`readNote` / `writeNote`).
  - `notes/<noteId>.md`: `<noteId>` is a UUID. Each file is markdown with a minimal YAML-ish frontmatter block parsed by a hand-rolled parser (not a YAML lib). Source: `src/main/notes-store.ts` (types `NoteMeta` / `Note`). Frontmatter fields:

    ```
    ---
    title: <string, quoted only if it contains parser-confusing chars>
    is_done: <true|false>
    created: <ISO-8601>
    updated: <ISO-8601>
    images: ["<uuid>.png", "<uuid>.jpg"]   ← JSON-encoded array of image filenames
    ---
    <markdown body>
    ```

  - `images/<uuid>.<ext>`: raw image bytes. Referenced **only** by filename in a note's `images` frontmatter array (not inline `![]()`). Orphans are garbage-collected against the union of all notes' `images` lists after every note write/delete.

## `<userData>/skills/` — Agent Skills plugin tree

- **Path**: `<userData>/skills/`
- **Format**: a Claude **plugin root** (the source of truth that gets projected verbatim, below). File tree:

  ```
  skills/
  ├── .claude-plugin/plugin.json     ← { "name": "shelf-skills" } (Shelf-ensured scaffold)
  └── skills/<name>/
      ├── SKILL.md                    ← user-authored markdown; <name> = folder = identity
      └── .locked                     ← optional marker: skill locked against AGENT edits
  ```

  - `<name>` is kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) and equals the folder name. The frontmatter `name:` is authoritative; the folder is renamed to match on save.
  - `SKILL.md`: opaque user markdown written verbatim. The store only parses `name` / `description` from its YAML frontmatter (lenient regex for the list view; strict `js-yaml` validation at save time to reject frontmatter Copilot would silently skip).
- **Source of truth**: `src/main/skills-store.ts` (types `SkillMeta` / `SkillUpdateResult`). Note the deliberate two-layer `skills/skills/` nesting (outer = plugin root, inner = skill collection) — must not be collapsed.

## `<userData>/app-instance-id`

- **Path**: `<userData>/app-instance-id`
- **Format**: a single line — one UUID (`crypto.randomUUID()`) + trailing newline. Plain text, not JSON.
- **Source of truth**: `src/main/app-instance-id.ts` (`getAppInstanceId()`). Generated once, persisted, cached in-process; survives restarts/updates, regenerates only on reinstall / userData wipe. Because it lives in `<userData>`, dev/test/prod each get a distinct id. Used as `<appId>`, the namespace for per-app projections under `~/.shelf/apps/<appId>/`.

## Other `<userData>` app-global files

- `pm-history.json` — JSON `{ chat: ChatMessage[], display: PmMessage[] }`. Source: `src/main/pm/history-store.ts`.
- `pm-global-note.md` — plain markdown (global PM note). Source: `src/main/pm/note-store.ts` (`readGlobalNote` / `writeGlobalNote`).
- `runtime-cache/<targetId>/…` — host-side cache of extracted Node + CLI binaries per arch×libc target. Source: `src/main/agent/deploy-layout.ts` (`cacheDir` / `cachedNodeBin` / `cachedClaudeBin` / `cachedCopilotBin`).
- `mcp-servers.json` — app-level MCP servers. **Keyed object** `Record<name, McpServerBlock>` (NOT an array, NOT wrapped in `mcpServers`): `{ "<name>": {type:'stdio',command,args?,env?} | {type:'http',url,headers?} }`. Name is the key. Stored opaque — `env`/`headers` may hold literal tokens or `${VAR}` refs (resolved later on the worker). Types + validators: `src/shared/mcp.ts`. CRUD: `src/main/mcp-store.ts`. See `context/mcp` (mcp#3).

## `<userData>/config-backup.json` — config-backup binding

- **Path**: `<userData>/config-backup.json`
- **Format**: JSON object `{ remoteUrl: string, machineLabel: string }` (`ConfigBackupBinding`, `src/shared/config-backup.ts`). `remoteUrl` 是使用者的 git remote（https 或 ssh，Shelf 不解析也不認證 —— 交給機器的 git 憑證）；`machineLabel` 是這台機器分支的顯示名。
- **Source of truth**: `src/main/config-backup/binding-store.ts`。**機器本地、永不進任何備份 payload**（描述「本機備份去哪」，是機器特定的，備份它會循環且洩漏 remote URL）。缺檔 = 未綁定。見 `context/config-backup` config-backup#1/#3。

## `<userData>/config-backup-intent.json` — Backup checklist intent

- **Format**：JSON string array，內容是上一次成功 Backup 的 selected item ids（`skill:<name>` / `mcp:<name>`）。
- **Source of truth**：`src/main/config-backup/intent-store.ts`。只用來預勾下次 checklist；它不是 remote inventory，也不讓未勾選項目產生刪除語意。沒有 saved Backup binding 時 `list()` 不回傳 intent。
- **Scope**：機器本地、永不進 payload。只有 Backup 成功（包含內容已相同、無需 push）後才更新。

## `<userData>/config-backup-repo/` — side-car git clone

- **Path**: `<userData>/config-backup-repo/`（一個一般 git clone，非 bare）
- **用途**：config-backup 的 transport cache。git **只**在這裡操作，永不包住 live 資料夾。可丟棄、隨時可刪（下次操作會重新 clone/fetch）。Backup 與 Import 共用此 clone，所以所有操作由 process-local lock 序列化；Import source 另 export 到 operation temp dir，不把此 working tree/index 當 pinned view。
- **Source of truth**: `src/main/config-backup/side-car.ts`（`simple-git`）。每台機器一個 `backup/<app-instance-id>` 分支，分支的 working-tree payload layout：

  ```
  <repo root>@backup/<app-instance-id>/
  ├── skills/<name>/…            ← 鏡射 <userData>/skills/skills/<name>/（整包，binary-safe）
  ├── mcp-servers.json           ← keyed object，只含備份時勾選的 server（verbatim block）
  └── machine.json               ← { appInstanceId, machineLabel }（BackupMachineManifest）— 給 Import 來源選單顯示 label
  ```

  layout 常數是 Skills/MCP 兩端共用的單一真相源（`REPO_SKILLS_DIR` / `REPO_MCP_FILE` / `REPO_MACHINE_MANIFEST`，`src/shared/config-backup.ts`）。Backup 的 selected Skill 取代同名整個目錄，selected MCP 取代同名 block；未選 remote payload 與不相關路徑不動。Import source revision token 只存在 process memory，綁定 remote URL + fetched commit，不持久化。`.locked` / `.disabled` 與 binding、intent、app identity 都不進 portable payload。見 `context/config-backup`、`architecture/config-backup`。

## `~/.shelf/apps/<appId>/skills/` — per-app skills projection

- **Path**: `os.homedir()/.shelf/apps/<appId>/skills/` (`<appId>` = `app-instance-id`)
- **Format**: a **whole-tree mirror** of `<userData>/skills/` (same plugin layout above). Projection is wipe-and-copy (covers deletes/renames for free); the projection is disposable, the `<userData>` source is the only truth. A sibling `~/.shelf/apps/<appId>/.heartbeat` lease file is touched on projection so the agent-server cleanup sweep doesn't reclaim a just-projected dir.
- **Source of truth**: `src/main/skills-projection.ts` (`localSkillsTarget` / `projectSkillsLocal`). This is the L2 (local) transport; L3 swaps the fs copy for scp/docker cp/wsl, with a content-hash `.synced` sentinel gating remote re-sync (`hashSkillsTree`). The agent-server always reads this path with zero local/remote branching (see `context/deployment` deployment#1).

## `~/.shelf/apps/<appId>/mcp-servers.json` — per-app MCP config projection

- **Path**: `os.homedir()/.shelf/apps/<appId>/mcp-servers.json` — the落點由 SHARED `shelfPlacement('mcp', {appId})` 決定(`src/shared/shelf-paths.ts`),placement 端與讀取端共用同一規則。
- **Format**: a copy of `<userData>/mcp-servers.json` (same keyed-object schema above). **UNLIKE skills 投影樹**:agent-server 不讓 SDK 自動讀,而是 session-create 時**讀+解析**這份檔組成 SDK `mcpServers` 參數(`agent-server/providers/mcp-config.ts`)。`${VAR}` 在此對 worker env 展開。
- **Source of truth**: local = `src/main/mcp-projection.ts` (`projectMcpLocal`);remote = `src/main/mcp-remote.ts` (`syncMcpForConnection`) 經 type-declared transport(`architecture/transport`)。app-dir `.heartbeat` lease 由 deploy 持有(`context/mcp` mcp#6)。

## `~/.shelf/apps/<appId>/projects/<projectId>/shell-history/` — target-local shell history

- **Path**: the home directory of the host running the initial shell, with separate `zsh` and `bash` files under `shell-history/`.
- **Format**: native shell-owned history content. Shelf chooses and protects the namespace but does not parse, mirror, merge, or synchronize entries.
- **Source of truth**: `src/main/terminal-runner/history-path.ts`. Zsh additionally uses the app-level immutable shim at `~/.shelf/apps/<appId>/shell-init/zsh/v1/.zshenv`; session/project values are launch environment, not shim content.
- **Lifecycle**: same-project tabs reuse the namespace. Project deletion tears down owned sessions before best-effort target removal; failures retain only a current-process retry snapshot. PowerShell, `sh`, and other runners do not create this history contract.

## `~/.shelf/agent-context/<sessionId>.json` — agent session context

- **Path**: `os.homedir()/.shelf/agent-context/<sessionId>.json` (keyed by sessionId, not projectId)
- **Format**: single JSON object — `PersistedContext` (`agent-server/context-store.ts`): `{ sessionId, provider, updatedAt, modelMessages?, totalInputTokens?, totalOutputTokens?, model?, lastResponseId?, lastSdkSessionId? }`. `lastSdkSessionId: null` is the explicit "cleared" sentinel.
- **Source of truth**: `agent-server/context-store.ts` (`loadContext` / `saveContext` / `deleteContext`). Written atomically (tmp + rename). The execution process's `wrapSendForContext` boundary is the single disk writer; it intercepts `context_patch` from both execution and session-scoped provider sinks, including a native session created during capability discovery. Files older than 30 days are swept by `cleanupOldContexts`. Lives on whichever machine the agent-server runs on.

## `~/.shelf/agent-server/<version>/` — deployed runtime (remote/local)

- **Path**: `<base>/.shelf/agent-server/<version>/` where `<base>` is the connection home (`~` for SSH, `/root` for Docker)
- **Format**: version-keyed (shared across apps, dedups the large binaries) file tree:

  ```
  agent-server/<version>/
  ├── node          ← pinned Node binary (glibc only; omitted for musl)
  ├── index.mjs     ← agent-server esbuild bundle
  ├── <provider>    ← optional provider-specific runtime payload
  └── .deployed     ← completion sentinel, written LAST
  ```

  The `.deployed` sentinel is written only after every expected payload file lands; redeploy is skipped only when the sentinel **and** all expected files are present (`needsDeploy`). A provider with a null runtime binding expects only the base runtime (`node` where applicable + `index.mjs`) and still follows the same deploy/sentinel contract.
- **Source of truth**: `src/main/agent/deploy-layout.ts` (`deployRoot` / `remoteFilePath` / `DEPLOY_FILES` / `deployFilesFor`). Remote paths are always POSIX (never `path.join`). See `context/deployment` deployment#2.
