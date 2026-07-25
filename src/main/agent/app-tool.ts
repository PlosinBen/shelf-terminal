/**
 * App-tool dispatcher (main side) — turns an `app_tool` request (op + args)
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
import { requestWorktreeClose } from '../worktree/close-gate';

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

interface AppToolDef {
  /** Safe (read-only) ops need no user confirmation; mutations do. */
  safe: boolean;
  run: (args: Record<string, unknown>, ctx: AppToolContext) => Promise<unknown>;
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
      const parsed = parseHttpOrigin(url);
      if (!parsed) throw new Error(`web.fetch: invalid or non-http(s) URL: ${url}`);
      const projectId = ctx.projectId ?? '';
      const method = typeof args.method === 'string' ? args.method : undefined;

      if (!isGranted(projectId, parsed.origin)) {
        const decision = await requestWebPermission({
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
      const parsed = parseHttpOrigin(url);
      if (!parsed) throw new Error(`web.open: invalid or non-http(s) URL: ${url}`);
      // Agent-supplied, non-authoritative — trimmed + length-capped so a runaway
      // string can't blow up the popup; shown as context, never trusted.
      const rawReason = typeof args.reason === 'string' ? args.reason.trim() : '';
      const reason = rawReason ? rawReason.slice(0, 300) : undefined;

      const decision = await requestBrowserOpen({
        url,
        origin: parsed.origin,
        registrableDomain: parsed.registrableDomain,
        reason,
      });
      if (decision === 'deny') {
        // Fail-loud: the agent must know not to retry (no silent swallow).
        throw new Error(`browser_open denied by user for ${parsed.origin}`);
      }

      openWebTab(ctx.projectId ?? '', url);
      return { opened: true, url: parsed.origin,
        message: `Opened ${url} in a Web tab. Ask the user to log in there, then retry browser_fetch.` };
    },
  },
  // NOTE: there is no `worktree_project.create` op — cutting a worktree is a
  // user-initiated UI action (sidebar New Worktree), not an agent tool (#entry).
  'worktree_project.finish': {
    // Self-close only: the feature's OWN agent finishes its OWN worktree (it has
    // the case context for the two-layer confirm's explanation). Gated by a
    // client-owned confirm popup; the renderer runs ff merge-back → teardown →
    // delete branch and reports the outcome.
    safe: false,
    run: (args, ctx) => {
      // Optional agent-supplied merge-back target (#target). The agent controls
      // which branch it synced/resolved against in the worktree, so it also names
      // where finish ff-pushes; undefined → the captured baseBranch (fork point).
      const target = typeof args.target === 'string' && args.target.trim()
        ? args.target.trim() : undefined;
      return runWorktreeClose('finish', ctx, target);
    },
  },
  'worktree_project.abandon': {
    // Like finish but no merge-back — the branch is discarded (force delete,
    // permanent commit loss), guarded by the popup's loss warning. No target.
    safe: false,
    run: (_args, ctx) => runWorktreeClose('abandon', ctx),
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

/**
 * Shared finish/abandon op body. Self-close: ctx.projectId is the worktree
 * sub-project being closed. Maps the popup outcome onto the tool result —
 * genuine failure (error) throws (ok:false); every other non-close outcome is a
 * CALM actionable result (closed:false + reason), so the agent adapts (retry on
 * busy, re-sync on non-ff, point the user at the base on base-dirty) instead of
 * treating it as a crash.
 */
async function runWorktreeClose(
  kind: 'finish' | 'abandon',
  ctx: AppToolContext,
  target?: string,
): Promise<unknown> {
  const subProjectId = ctx.projectId ?? '';
  if (!subProjectId) throw new Error(`worktree_project.${kind}: no calling project context`);

  const res = await requestWorktreeClose({ kind, subProjectId, target });
  switch (res.outcome) {
    case 'closed':
      return { closed: true };
    case 'cancelled':
      return { closed: false, cancelled: true };
    case 'busy':
      return { closed: false, reason: 'busy', message: 'another finish is in progress for this repo — retry shortly' };
    case 'non-ff':
      return { closed: false, reason: 'non-ff', message: 'the base branch advanced — re-sync (merge base into the worktree) and retry' };
    case 'base-dirty':
      return { closed: false, reason: 'base-dirty', message: 'the base worktree has uncommitted changes — resolve them there, then retry' };
    default:
      throw new Error(res.error ?? `worktree ${kind} failed`);
  }
}

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
