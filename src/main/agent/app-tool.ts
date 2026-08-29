/**
 * App-tool dispatcher (main side) — executions an `app_tool` request (op + args)
 * coming from an agent-server bridge tool into a call against client-owned
 * resources (currently app-level skills via skills-store), and returns a
 * structured result the bridge tool relays back to the model.
 *
 * Shape is the B-registry from .agent/features/app-level-capabilities.md:
 * `op = resource.verb`, each entry flags `safe` (read = no confirm) so the
 * caller can gate mutations. This module is the SINGLE place that maps an op to
 * a resource action — adding an app tool = add a registry entry + (for writes)
 * its mutation path. PURE of any wire/IPC concern, so it's unit-testable.
 *
 * Step 1 ships the safe READ ops only (list/get). Mutations (create/update) +
 * their confirm + the skills:changed broadcast land in later steps.
 */
import {
  listSkills, getSkill, createSkill, updateSkill, isSkillLocked,
  listSkillAuxFiles, readSkillFile, writeSkillFile, deleteSkillFile, resolveAuxPath,
} from '../skills-store';
import { onSkillsChanged } from '../skills-sync';
import { webFetch } from '../web-session';
import { parseHttpOrigin } from '../web-session-helpers';
import { isGranted, grant } from '../web-grants';
import { requestWebPermission } from '../web-permission';
import { requestBrowserOpen, openWebTab } from '../browser-open';
import { getMainWindow } from '../app-state';
import { getProjectsRepository } from '../projects/repository-provider';
import { createConnector } from '../connector';
import { listFeatureNotes } from '../worktree/feature-notes';
import { IPC } from '@shared/ipc-channels';

/** Per-call context the bridge threads in (which tab/project asked). */
export interface AppToolContext {
  /** Owning project — the web.fetch grant key is (projectId, origin). */
  projectId?: string;
}

export interface AppToolResult {
  ok: boolean;
  /** Present when ok — JSON-serializable payload for the tool result. */
  data?: unknown;
  /** Present when !ok — human-readable reason surfaced to the model. */
  error?: string;
}

export const NESTED_WORKTREE_CREATE_ERROR =
  'Cannot create a worktree project from a worktree project. Continue in the current child project and use propose_worktree_finish when the work is ready.';

interface AppToolDef {
  /** Safe (read-only) ops need no user confirmation; mutations do. */
  safe: boolean;
  run: (args: Record<string, unknown>, ctx: AppToolContext) => Promise<unknown>;
}

function normalizeProposedNotePaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const notePath = value.trim();
    if (!notePath || seen.has(notePath)) return;
    seen.add(notePath);
    out.push(notePath);
  };
  add(args.note);
  if (Array.isArray(args.notes)) {
    for (const note of args.notes) add(note);
  }
  return out;
}

async function resolveProposedNotePaths(projectId: string, identifiers: readonly string[]): Promise<string[]> {
  if (identifiers.length === 0) return [];

  const project = getProjectsRepository().get(projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  if (!project.featureNoteDir) {
    throw new Error('cannot propose feature notes: this project has no feature note directory configured');
  }

  const listed = await listFeatureNotes(
    createConnector(project.connection),
    project.cwd,
    project.featureNoteDir,
  );
  if (!listed.ok) throw new Error(`cannot list configured feature notes: ${listed.error}`);

  const byPath = new Map(listed.notes.map((note) => [note.path, note.path]));
  const byBasename = new Map<string, string[]>();
  for (const note of listed.notes) {
    const basename = note.path.split('/').pop() ?? note.path;
    byBasename.set(basename, [...(byBasename.get(basename) ?? []), note.path]);
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    let canonical = byPath.get(identifier);
    if (!canonical) {
      const basenameMatches = byBasename.get(identifier) ?? [];
      if (basenameMatches.length > 1) {
        throw new Error(`ambiguous feature note identifier: ${identifier}`);
      }
      canonical = basenameMatches[0];
    }
    if (!canonical) throw new Error(`feature note not found: ${identifier}`);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      resolved.push(canonical);
    }
  }
  return resolved;
}

const REGISTRY: Record<string, AppToolDef> = {
  'app_skill.list': {
    safe: true,
    run: async () => ({ skills: await listSkills() }),
  },
  'app_skill.get': {
    safe: true,
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) throw new Error('app_skill.get requires a "name"');
      const content = await getSkill(name);
      if (content === null) throw new Error(`skill not found: ${name}`);
      // `files` lets the model SEE bundled scripts/resources (read them via
      // read_app_skill_file); excludes SKILL.md (already in `content`) + .locked.
      const files = await listSkillAuxFiles(name);
      return { name, content, files };
    },
  },
  'app_skill.read_file': {
    safe: true,
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const filePath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!name) throw new Error('app_skill.read_file requires a "name"');
      if (!filePath) throw new Error('app_skill.read_file requires a "path"');
      if (await getSkill(name) === null) throw new Error(`skill not found: ${name}`);
      // Distinguish an invalid/reserved path (guard) from a genuinely absent file.
      if (resolveAuxPath(name, filePath) === null) throw new Error(`invalid or reserved skill file path: ${filePath}`);
      const content = await readSkillFile(name, filePath);
      if (content === null) throw new Error(`file not found: ${filePath}`);
      return { name, path: filePath, content };
    },
  },
  'app_skill.write_file': {
    safe: false,
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const filePath = typeof args.path === 'string' ? args.path.trim() : '';
      const content = args.content;
      if (!name) throw new Error('app_skill.write_file requires a "name"');
      if (!filePath) throw new Error('app_skill.write_file requires a "path"');
      if (typeof content !== 'string') throw new Error('app_skill.write_file requires "content" (a string)');
      // Aux files cannot bootstrap a skill — identity comes only from SKILL.md.
      if (await getSkill(name) === null) throw new Error(`skill not found: ${name} (use create_app_skill to make a new one)`);
      // Lock = the user's hard "agent, hands off this whole skill" — covers aux
      // files too, enforced here so it holds under bypass permission mode.
      if (isSkillLocked(name)) throw new Error(`skill '${name}' is locked against agent edits; unlock it in the Skills panel`);
      const res = await writeSkillFile(name, filePath, content);
      if (!res.ok) throw new Error(res.error ?? 'failed to write skill file');
      onSkillsChanged();
      return { name, path: filePath };
    },
  },
  'app_skill.delete_file': {
    safe: false,
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const filePath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!name) throw new Error('app_skill.delete_file requires a "name"');
      if (!filePath) throw new Error('app_skill.delete_file requires a "path"');
      if (await getSkill(name) === null) throw new Error(`skill not found: ${name}`);
      if (isSkillLocked(name)) throw new Error(`skill '${name}' is locked against agent edits; unlock it in the Skills panel`);
      // SKILL.md / .locked are reserved in resolveAuxPath → can never be deleted
      // here, so this op can never orphan a skill's SKILL.md.
      const res = await deleteSkillFile(name, filePath);
      if (!res.ok) throw new Error(res.error ?? 'failed to delete skill file');
      onSkillsChanged();
      return { name, path: filePath };
    },
  },
  'app_skill.create': {
    safe: false, // mutation — gated by the tool permission prompt
    run: async (args) => {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content.trim()) throw new Error('app_skill.create requires "content" (a full SKILL.md)');
      // Materialise a placeholder, then write the real content — its frontmatter
      // `name` becomes the identity (folder renamed to match; collision → error).
      const placeholder = await createSkill();
      const res = await updateSkill(placeholder.name, content);
      if (!res.ok) {
        // Roll back the empty placeholder so a failed create leaves nothing.
        await deleteSkillSafe(placeholder.name);
        throw new Error(res.error ?? 'failed to create skill');
      }
      onSkillsChanged();
      return { name: res.name };
    },
  },
  'web.fetch': {
    // The per-(project,origin) gate lives HERE — the single provider-agnostic
    // choke point both Claude and Copilot funnel through (so behaviour is
    // identical, and bypass mode is gated automatically because the tool still
    // executes this). A granted origin runs with no prompt; an un-granted one
    // raises a generic web-permission popup (decoupled from the agent timeline).
    safe: false,
    run: async (args, ctx) => {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!url) throw new Error('web.fetch requires a "url"');
      const projectId = ctx.projectId;
      if (!projectId) throw new Error('web.fetch requires a project context');
      const parsed = parseHttpOrigin(url);
      if (!parsed) throw new Error(`web.fetch: invalid or non-http(s) URL: ${url}`);
      const method = typeof args.method === 'string' ? args.method : undefined;

      if (!isGranted(projectId, parsed.origin)) {
        const decision = await requestWebPermission({
          projectId,
          origin: parsed.origin,
          registrableDomain: parsed.registrableDomain,
          method: method ?? 'GET',
        });
        if (decision === 'deny') {
          throw new Error(`web.fetch denied by user for ${parsed.origin}`);
        }
        if (decision === 'always') grant(projectId, parsed.origin);
      }

      const headers = (args.headers && typeof args.headers === 'object')
        ? (args.headers as Record<string, string>) : undefined;
      const body = typeof args.body === 'string' ? args.body : undefined;
      // Return the raw {status, headers, body}. No auth/expiry interpretation —
      // the agent/user judges from the actual response (a login page or 401/400
      // is not reliably distinguishable from real data on the wire).
      return await webFetch({ url, method, headers, body });
    },
  },
  'web.open': {
    // Open a visible Web tab for the user to log in. Carries its OWN per-call
    // confirm popup (browser-open.ts) — Open/Deny only, never remembered, so a
    // single approval can't enable background opens. safe:false + the provider
    // skips the SDK tool prompt (canUseTool/skipPermission), so this gate is the
    // single choke point (runs even in bypass mode — the tool still executes).
    safe: false,
    run: async (args, ctx) => {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!url) throw new Error('web.open requires a "url"');
      const projectId = ctx.projectId;
      if (!projectId) throw new Error('web.open requires a project context');
      const parsed = parseHttpOrigin(url);
      if (!parsed) throw new Error(`web.open: invalid or non-http(s) URL: ${url}`);
      // Agent-supplied, non-authoritative — trimmed + length-capped so a runaway
      // string can't blow up the popup; shown as context, never trusted.
      const rawReason = typeof args.reason === 'string' ? args.reason.trim() : '';
      const reason = rawReason ? rawReason.slice(0, 300) : undefined;

      const decision = await requestBrowserOpen({
        projectId,
        url,
        origin: parsed.origin,
        registrableDomain: parsed.registrableDomain,
        reason,
      });
      if (decision === 'deny') {
        // Fail-loud: the agent must know not to retry (no silent swallow).
        throw new Error(`browser_open denied by user for ${parsed.origin}`);
      }

      openWebTab(projectId, url);
      return { opened: true, url: parsed.origin,
        message: `Opened ${url} in a Web tab. Ask the user to log in there, then retry browser_fetch.` };
    },
  },
  // Worktree lifecycle mutations remain user-initiated UI. These proposal ops
  // only open the relevant UI, so the human still reviews and commits Create /
  // Finish; neither op runs git or creates/removes a worktree.
  'worktree.propose_create': {
    safe: false,
    run: async (args, ctx) => {
      const projectId = ctx.projectId;
      if (!projectId) throw new Error('worktree.propose_create requires a project context');
      const project = getProjectsRepository().get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (project.parentProjectId) throw new Error(NESTED_WORKTREE_CREATE_ERROR);
      const win = getMainWindow();
      if (!win || win.isDestroyed()) throw new Error('cannot open New Worktree dialog: no application window');
      const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
      const notePaths = await resolveProposedNotePaths(projectId, normalizeProposedNotePaths(args));
      win.webContents.send(IPC.WORKTREE_PROPOSE_CREATE, { projectId, ...(branch ? { branch } : {}), notePaths });
      return {
        opened: true,
        ...(branch ? { branch } : {}),
        notePaths,
        message: 'Opened the New Worktree dialog. The user must review and press Create.',
      };
    },
  },
  'worktree.propose_finish': {
    safe: false,
    run: async (_args, ctx) => {
      const projectId = ctx.projectId;
      if (!projectId) throw new Error('worktree.propose_finish requires a project context');
      const project = getProjectsRepository().get(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      if (!project.parentProjectId) throw new Error(`${project.name} is not a worktree — nothing to finish`);
      const win = getMainWindow();
      if (!win || win.isDestroyed()) throw new Error('cannot open Finish Worktree gate: no application window');
      win.webContents.send(IPC.WORKTREE_PROPOSE_FINISH, { projectId });
      return { opened: true, message: 'Opened the Finish Worktree gate. The user must review and press Finish.' };
    },
  },
  'app_skill.update': {
    safe: false,
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!name) throw new Error('app_skill.update requires a "name"');
      if (!content.trim()) throw new Error('app_skill.update requires "content" (a full SKILL.md)');
      // updateSkill UPSERTS at the store level (the create flow relies on that),
      // so without this guard "updating" a wrong/typo'd name would silently
      // CREATE a skill. The agent contract is overwrite-existing-only — direct
      // it to create_app_skill instead by failing on a missing target.
      if (await getSkill(name) === null) throw new Error(`skill not found: ${name} (use create_app_skill to make a new one)`);
      // Lock = the user's hard "agent, hands off this skill" — enforced here so
      // it holds even in bypass permission mode (where the update confirm is
      // pre-granted). The manager UI is the only way to edit/unlock a locked one.
      if (isSkillLocked(name)) throw new Error(`skill '${name}' is locked against agent edits; unlock it in the Skills panel`);
      const res = await updateSkill(name, content);
      if (!res.ok) throw new Error(res.error ?? 'failed to update skill');
      onSkillsChanged();
      return { name: res.name };
    },
  },
};

async function deleteSkillSafe(name: string): Promise<void> {
  try {
    const { deleteSkill } = await import('../skills-store');
    await deleteSkill(name);
  } catch { /* best-effort rollback */ }
}

/** True iff `op` is a known safe (read-only) op — caller may skip confirmation. */
export function isSafeAppToolOp(op: string): boolean {
  return REGISTRY[op]?.safe === true;
}

/** True iff `op` is registered at all. */
export function isKnownAppToolOp(op: string): boolean {
  return op in REGISTRY;
}

/** Run an app-tool op. Never throws — failures come back as `{ ok:false, error }`. */
export async function handleAppTool(op: string, args: Record<string, unknown> = {}, ctx: AppToolContext = {}): Promise<AppToolResult> {
  const def = REGISTRY[op];
  if (!def) return { ok: false, error: `unknown app_tool op: ${op}` };
  try {
    return { ok: true, data: await def.run(args, ctx) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
