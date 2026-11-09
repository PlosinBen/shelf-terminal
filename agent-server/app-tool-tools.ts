/**
 * Shelf-owned tool contracts and bridge execution, independent of provider SDKs.
 * Adapters own registration and protocol-specific result envelopes.
 * See context/skills (`skills#2`, the app-skill bridge).
 */
import { callMain } from './app-tool-client';
import { WEB_FETCH_TOOL, BROWSER_OPEN_TOOL } from '@shared/web-session';
import { z } from 'zod';
import { DELEGATION as D } from '@shared/agent-delegation';

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

export const PROPOSE_WORKTREE_CREATE_DESC =
  'Open the New Worktree dialog for the current parent project, optionally prefilled with a suggested branch, feature-note file(s), '
  + 'and agent provider key. This tool creates nothing. The user reviews and may override the branch, selected notes, Agent view '
  + 'and Terminal view before pressing Create. Agent defaults to none and Terminal defaults to enabled; at least one initial view '
  + 'is required. On confirmation Shelf creates the Git worktree and child project, migrates selected notes, and connects the child. '
  + 'Startup views follow the final selections; Agent identity and preferences are fresh. Other project setup is inherited. '
  + 'Calls from a worktree child are rejected. Args: branch (optional suggested branch), note (optional legacy single feature-note '
  + 'filename/path), notes (optional feature-note filenames/paths), agent (optional registered provider key, not a model or session; '
  + 'invalid or unavailable keys are rejected).';

export const PROPOSE_WORKTREE_FINISH_DESC =
  'Open the Finish Worktree gate for the current worktree child. This tool merges or removes nothing. The user reviews the target '
  + 'and confirms Finish. If confirmed, Shelf requires a clean child worktree, fast-forwards the selected target, restores remaining '
  + 'configured feature-note files, and removes the child checkout and project only after every step succeeds. Calls outside a '
  + 'worktree child are rejected.';

// mcp#12: SDK/HTTP registration belongs in adapters, never in this contract.
export interface BridgeToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  operation: string;
}
export const SHELF_BRIDGE_TOOLS: BridgeToolSpec[] = [
  { name: D.TOOL.SELECT, description: 'Ask the user to select an already-open worktree Agent View in Shelf. Waits for the user selection; returns the stable target identity or cancellation. Does not start work.', operation: D.OP.SELECT, inputSchema: {} },
  { name: D.TOOL.START, description: 'Start a delegation to the target the user selected with shelf_select_agent. Send the first text task. Returns delegationId and queue receipt, NOT the experiment result. Keep doing other work; results are manually collected by the user.', operation: D.OP.START,
    inputSchema: { projectId: z.string(), agentViewId: z.string(), content: z.string() } },
  { name: D.TOOL.SEND, description: 'Send the next text task within your existing delegation. User intervention temporarily rejects sends; query status and wait for the user, never automatically retry an uncertain delivery.', operation: D.OP.SEND,
    inputSchema: { delegationId: z.string(), content: z.string() } },
  { name: D.TOOL.STATUS, description: 'Query status of your delegation(s): intervention, availability, delivery and whether a result awaits collection. Never returns result text. Omit delegationId to list only delegations you participate in.', operation: D.OP.STATUS,
    inputSchema: { delegationId: z.string().optional() } },
  { name: D.TOOL.PROGRESS, description: 'As the delegated worker, update the latest short progress text for this delegation. UI only: does not notify the main conversation or mark a result complete.', operation: D.OP.PROGRESS,
    inputSchema: { delegationId: z.string(), content: z.string() } },
  { name: D.TOOL.RESULT, description: 'As the delegated worker, explicitly submit the final plain-text result of the current phase. Only one uncollected result is allowed. Returns immediately after storing; the user collects it later. The delegation stays active for subsequent tasks.', operation: D.OP.RESULT,
    inputSchema: { delegationId: z.string(), content: z.string() } },
  { name: 'list_app_skills', description: APP_SKILL_LIST_DESC, inputSchema: {}, operation: 'app_skill.list' },
  {
    name: 'get_app_skill', description: APP_SKILL_GET_DESC, operation: 'app_skill.get',
    inputSchema: { name: z.string().describe('skill folder name from list_app_skills') },
  },
  {
    name: 'create_app_skill', description: APP_SKILL_CREATE_DESC, operation: 'app_skill.create',
    inputSchema: { content: z.string().describe('full SKILL.md (frontmatter name+description + body)') },
  },
  {
    name: 'update_app_skill', description: APP_SKILL_UPDATE_DESC, operation: 'app_skill.update',
    inputSchema: {
      name: z.string().describe('current skill folder name'),
      content: z.string().describe('full new SKILL.md'),
    },
  },
  {
    name: 'read_app_skill_file', description: APP_SKILL_READ_FILE_DESC, operation: 'app_skill.read_file',
    inputSchema: {
      name: z.string().describe('skill folder name'),
      path: z.string().describe('folder-relative aux-file path from get_app_skill `files`'),
    },
  },
  {
    name: 'write_app_skill_file', description: APP_SKILL_WRITE_FILE_DESC, operation: 'app_skill.write_file',
    inputSchema: {
      name: z.string().describe('skill folder name'),
      path: z.string().describe('folder-relative aux-file path (no leading slash, no ..)'),
      content: z.string().describe('file content'),
    },
  },
  {
    name: 'delete_app_skill_file', description: APP_SKILL_DELETE_FILE_DESC, operation: 'app_skill.delete_file',
    inputSchema: {
      name: z.string().describe('skill folder name'),
      path: z.string().describe('folder-relative aux-file path'),
    },
  },
  {
    name: WEB_FETCH_TOOL, description: WEB_FETCH_DESC, operation: 'web.fetch',
    inputSchema: {
      url: z.string().describe('absolute http(s) URL of the internal service'),
      method: z.string().optional().describe('HTTP method (default GET)'),
      headers: z.record(z.string(), z.string()).optional().describe('extra request headers, e.g. {"kbn-xsrf":"true"}'),
      body: z.string().optional().describe('request body, e.g. a JSON query string'),
    },
  },
  {
    name: BROWSER_OPEN_TOOL, description: BROWSER_OPEN_DESC, operation: 'web.open',
    inputSchema: {
      url: z.string().describe('absolute http(s) URL to open in a visible Web tab for the user to log in'),
      reason: z.string().optional().describe('short explanation of why this page must be opened (shown in the approval popup)'),
    },
  },
  {
    name: 'propose_worktree_create', description: PROPOSE_WORKTREE_CREATE_DESC, operation: 'worktree.propose_create',
    inputSchema: {
      branch: z.string().optional().describe('suggested new branch name'),
      note: z.string().optional().describe('legacy single feature note filename/path to preselect'),
      notes: z.array(z.string()).optional().describe('feature note filenames/paths to preselect'),
      agent: z.string().optional().describe('registered provider key to preselect for Agent view; not a model or existing session'),
    },
  },
  { name: 'propose_worktree_finish', description: PROPOSE_WORKTREE_FINISH_DESC, inputSchema: {}, operation: 'worktree.propose_finish' },
];

/** These tools map declared input fields directly to the same main-op fields.
 * Select only schema keys (including omitted optional values), matching the old
 * explicit destructuring. SDK adapters validate input; this does not parse it. */
export function bridgeToolArgs(tool: BridgeToolSpec, input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(tool.inputSchema).map(key => [key, input[key]]));
}

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
