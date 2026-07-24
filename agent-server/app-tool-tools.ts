/**
 * Provider-agnostic handler + copy for the in-process bridge tools that expose
 * client-owned resources (app-level skills) to the model. Each provider
 * registers these via its own SDK API (claude `tool()` / copilot `defineTool`),
 * but the handler body — call main, format the result — is shared here.
 * See context/skills (`skills#2`, the app-skill bridge).
 */
import { callMain } from './app-tool-client';
import { WEB_FETCH_TOOL, BROWSER_OPEN_TOOL } from '@shared/web-session';

export const APP_SKILL_LIST_DESC =
  'List the app-level Agent Skills available in this app (each skill\'s name and description). '
  + 'Use this before creating a skill to avoid duplicate names, or to find one to read/update.';

export const APP_SKILL_GET_DESC =
  'Read one app-level skill by its folder name (as returned by list_app_skills). Returns the full SKILL.md '
  + 'content AND `files` — the skill\'s bundled aux files (scripts, reference docs) as folder-relative paths. '
  + 'Use read_app_skill_file to read one of those files.';

export const APP_SKILL_READ_FILE_DESC =
  'Read one bundled aux file of an app-level skill (a script or reference doc, NOT SKILL.md itself). '
  + '`name` is the skill folder name; `path` is a folder-relative path as listed in get_app_skill\'s `files`.';

export const APP_SKILL_WRITE_FILE_DESC =
  'Create or overwrite one bundled aux file inside an app-level skill\'s folder (e.g. `scripts/build.sh`, '
  + '`reference.md`). `name` is the skill folder name (the skill must already exist — use create_app_skill '
  + 'first); `path` is a folder-relative path (no leading slash, no `..`); `content` is the file text. '
  + 'Cannot write SKILL.md (use update_app_skill) and fails if the skill is locked. Takes effect on the next session.';

export const APP_SKILL_DELETE_FILE_DESC =
  'Delete one bundled aux file from an app-level skill\'s folder. `name` is the skill folder name; `path` is '
  + 'a folder-relative path. Cannot delete SKILL.md (deleting a whole skill is UI-only) and fails if the skill '
  + 'is locked. Takes effect on the next session.';

export const APP_SKILL_CREATE_DESC =
  'Create a new app-level Agent Skill. `content` is the full SKILL.md, including YAML frontmatter with `name` '
  + '(lowercase kebab-case — this is the skill\'s identity) and `description`, followed by the markdown body. '
  + 'Fails if a skill with that name already exists (read list_app_skills first, or use update_app_skill). '
  + 'Takes effect for the agent on the next session.';

export const APP_SKILL_UPDATE_DESC =
  'Overwrite an existing app-level skill. `name` is its current folder name; `content` is the full new SKILL.md '
  + '(its frontmatter `name` may rename the skill). Fails if the skill is locked (the user has reserved it — '
  + 'do not retry; list_app_skills reports `locked`). Takes effect on the next session.';

export const WEB_FETCH_DESC =
  "HTTP request to an internal/SSO-protected web service using the USER's logged-in browser session "
  + '(their cookies, from this machine — NOT this shell\'s network). Use this for company web apps the user '
  + 'has signed into in a Web tab (e.g. Kibana, ArgoCD): prefer their JSON APIs (Kibana `_search`, ArgoCD '
  + '`/api/v1/applications`) over scraping HTML. For ordinary shell/network access use bash/curl instead — that '
  + "runs from this environment without the user's identity. The user is prompted to authorize each origin. "
  + 'Returns the raw { status, headers, body }. If the response looks like a login page or an auth error (e.g. a '
  + '401/400, or a 3xx redirect to a login/SSO URL in the Location header), the session is likely not logged in — '
  + 'tell the user to log in to that service in a Web tab, then retry. '
  + 'Args: url (required), method (default GET), headers (object), body (string, e.g. a JSON query).';

export const BROWSER_OPEN_DESC =
  "Open a URL in a visible Web tab so the USER can interact with it — primarily to LOG IN to "
  + 'an internal/SSO service so a later browser_fetch can use their authenticated session. Use '
  + 'this when browser_fetch returns a login page or an auth error (401/400, or a 3xx redirect to '
  + 'a login/SSO URL): call browser_open with the login or service URL. The user is prompted to '
  + 'approve each open (a visible tab appears — nothing opens in the background), then signs in. '
  + 'After they confirm they are logged in, retry browser_fetch. This tool only OPENS the tab — it '
  + 'returns no page content and does not wait for login to finish. Args: url (required, absolute '
  + 'http(s) URL); reason (optional, a short human-readable explanation of WHY you need this page '
  + "opened — shown in the approval popup, since the popup hides your chat message while the user "
  + 'decides).';

export const WORKTREE_CREATE_DESC =
  'Cut a new git worktree + an isolated Shelf sub-project for a feature, so it develops in parallel while the '
  + 'base branch is freed for other work. Use this in the worktree dev flow once the spec/plan is settled (or '
  + 'earlier if isolation is wanted). The user is prompted to confirm before anything is created. '
  + 'Args: branch (required — the new branch name); notePath (optional — path RELATIVE to the base project cwd of a '
  + 'Phase-0 feature note to carry into the worktree so the fresh agent boots with it). Returns { created: true, '
  + 'projectId } on approve, or { created: false, cancelled: true } if the user declines (a normal outcome — adapt, '
  + 'do not retry blindly).';

export const WORKTREE_FINISH_DESC =
  'Finish THIS worktree: fast-forward-merge its branch back into the base branch it was cut from, then close it '
  + '(remove the worktree dir + delete the branch). Only the worktree\'s OWN agent may finish it. FIRST sync (merge '
  + 'the base branch into this worktree) and verify (run the project\'s tests) — call this only when green and the '
  + 'working tree is committed/clean. The user is prompted to confirm. Returns { closed: true } on success; '
  + '{ closed: false, reason } otherwise — cancelled (user declined), busy (another finish holds the repo — retry '
  + 'shortly), non-ff (the base advanced since sync — re-sync then retry), or base-dirty (the base worktree has '
  + 'uncommitted changes — the user must resolve them).';

export const WORKTREE_ABANDON_DESC =
  'Abandon THIS worktree: discard it WITHOUT merging — remove the worktree dir and FORCE-delete its branch, '
  + 'permanently dropping any unmerged commits. Only the worktree\'s own agent may abandon it. Use when the feature '
  + 'is dropped. The user is prompted to confirm (the popup warns about the permanent loss). Returns { closed: true } '
  + 'or { closed: false, cancelled: true }.';

/** Agent-facing tool names (flat, underscored) for the worktree_project family. */
export const WORKTREE_TOOL = {
  create: 'worktree_project_create',
  finish: 'worktree_project_finish',
  abandon: 'worktree_project_abandon',
} as const;

/** Corresponding main-side app-tool op keys (resource.verb registry convention). */
export const WORKTREE_OP = {
  create: 'worktree_project.create',
  finish: 'worktree_project.finish',
  abandon: 'worktree_project.abandon',
} as const;

/**
 * Canonical inventory of the in-process Shelf bridge tools (name + description).
 * Single source for the `/mcp` card's `shelf` entry. The bridge is registered
 * per-provider (claude `tool()` inside `createSdkMcpServer` / copilot `defineTool`
 * in `config.tools`) — Claude's SDK then reports it back via `mcpServerStatus()`,
 * but Copilot's `mcp.list()` does NOT (it's `config.tools`, not an MCP server),
 * so Copilot composes its `shelf` entry from this list. Keep in sync with each
 * provider's registration (same names/descriptions).
 */
export interface BridgeToolSpec { name: string; description: string; }
export const SHELF_BRIDGE_TOOLS: BridgeToolSpec[] = [
  { name: 'list_app_skills', description: APP_SKILL_LIST_DESC },
  { name: 'get_app_skill', description: APP_SKILL_GET_DESC },
  { name: 'create_app_skill', description: APP_SKILL_CREATE_DESC },
  { name: 'update_app_skill', description: APP_SKILL_UPDATE_DESC },
  { name: 'read_app_skill_file', description: APP_SKILL_READ_FILE_DESC },
  { name: 'write_app_skill_file', description: APP_SKILL_WRITE_FILE_DESC },
  { name: 'delete_app_skill_file', description: APP_SKILL_DELETE_FILE_DESC },
  { name: WEB_FETCH_TOOL, description: WEB_FETCH_DESC },
  { name: BROWSER_OPEN_TOOL, description: BROWSER_OPEN_DESC },
  { name: WORKTREE_TOOL.create, description: WORKTREE_CREATE_DESC },
  { name: WORKTREE_TOOL.finish, description: WORKTREE_FINISH_DESC },
  { name: WORKTREE_TOOL.abandon, description: WORKTREE_ABANDON_DESC },
];

export interface BridgeToolText {
  text: string;
  isError: boolean;
}

/** Run a bridge op via main and format its result as the text a tool returns. */
export async function runBridgeTool(op: string, args: Record<string, unknown>): Promise<BridgeToolText> {
  const r = await callMain(op, args);
  if (r.ok) {
    return { text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? null), isError: false };
  }
  return { text: `Error: ${r.error ?? 'app tool failed'}`, isError: true };
}
