import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { load as parseYaml, YAMLException } from 'js-yaml';
import { log } from '@shared/logger';

/**
 * App-level Agent Skills store (see agent feature `skills-workflows`).
 *
 * Source of truth lives under `<userData>/skills/` — which is ALSO the Claude
 * plugin root, so projection (L2/L3) is a straight whole-tree copy. Layout:
 *
 *   <userData>/skills/
 *   ├── .claude-plugin/plugin.json   ← { "name": "shelf-skills" } (Shelf-ensured)
 *   └── skills/<name>/SKILL.md       ← one folder per skill; <name> = identity
 *
 * A SKILL.md is USER-authored raw markdown (open standard, portable). The store
 * treats it as opaque: it writes content verbatim and only PARSES `name` /
 * `description` out of the YAML frontmatter for the list view + identity. The
 * folder name is the identity; `name` in the frontmatter is the source of truth
 * and the folder is renamed to match on save (kebab-case, validated).
 */

export interface SkillMeta {
  /** Folder name = skill identity (kebab-case). */
  name: string;
  /** `description` from the frontmatter (for the list subtitle). */
  description?: string;
  /** True when the user has locked this skill against AGENT edits (the manager
   *  UI can still edit/unlock it). Marker = a `.locked` file in the folder. */
  locked?: boolean;
}

export interface SkillUpdateResult {
  ok: boolean;
  /** The (possibly renamed) skill name on success. */
  name?: string;
  error?: string;
}

export interface SkillFileResult {
  ok: boolean;
  error?: string;
}

const PLUGIN_NAME = 'shelf-skills';

function skillsRoot(): string {
  return path.join(app.getPath('userData'), 'skills');
}
function collectionDir(): string {
  return path.join(skillsRoot(), 'skills');
}
function skillDir(name: string): string {
  return path.join(collectionDir(), name);
}
function skillFile(name: string): string {
  return path.join(skillDir(name), 'SKILL.md');
}

/** Absolute path to the skills collection dir (`<userData>/skills/skills`).
 *  Exposed so config-backup can copy whole skill folders in/out without
 *  duplicating the on-disk layout. */
export function skillsCollectionDir(): string {
  return collectionDir();
}
/** Absolute path to one skill's folder. See skillsCollectionDir(). */
export function skillDirPath(name: string): string {
  return skillDir(name);
}
/** Lock marker: a `.locked` file inside the skill folder. In-folder so a rename
 *  carries it for free; a stray dotfile is ignored by the skill loaders. */
function lockMarkerPath(name: string): string {
  return path.join(skillDir(name), '.locked');
}
function manifestPath(): string {
  return path.join(skillsRoot(), '.claude-plugin', 'plugin.json');
}

/** Top-level files an agent may NOT touch via the generic aux-file ops: SKILL.md
 *  (owned by update_app_skill — identity/rename/YAML validation) and `.locked`
 *  (the user's UI-only agent-handsoff marker). Reserving them in the path guard
 *  is what makes "an agent can never orphan a skill's SKILL.md" true. */
const RESERVED_AUX_FILES = new Set(['SKILL.md', '.locked']);

/** Ensure the plugin scaffold exists so the tree is projection-ready. Idempotent. */
function ensureScaffold(): void {
  fs.mkdirSync(collectionDir(), { recursive: true });
  const mp = manifestPath();
  if (!fs.existsSync(mp)) {
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, JSON.stringify({ name: PLUGIN_NAME }, null, 2) + '\n', 'utf-8');
  }
}

/** kebab-case: lowercase alnum, single hyphens, no leading/trailing hyphen. Also
 *  path-safe (no `/ \ .` / space / uppercase). */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Validate that the SKILL.md frontmatter parses as STRICT YAML — the same gate
 * the Copilot CLI applies when loading skills. The store's own `parseSkillMeta`
 * is deliberately lenient (regex), so an invalid-YAML frontmatter (most commonly
 * an unquoted value containing a colon, e.g. `description: foo: bar`) sails past
 * it AND past Claude's lenient loader — but Copilot SILENTLY SKIPS the skill. The
 * result is a skill that "works" under Claude and vanishes under Copilot with no
 * error anywhere. We reject it at save time instead (fail-loud). Returns an error
 * string, or null when the frontmatter is valid (or absent — `updateSkill`'s
 * `name:` check handles a missing block). Pure → unit-testable. See GOTCHAS.
 */
export function validateFrontmatterYaml(content: string): string | null {
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    parseYaml(m[1]);
    return null;
  } catch (err) {
    const reason = err instanceof YAMLException ? err.reason : (err as Error).message;
    return `SKILL.md frontmatter is not valid YAML: ${reason}. Tip: wrap any value containing a colon in double quotes (e.g. description: "a: b").`;
  }
}

/** Lenient read-only parse of `name` / `description` from SKILL.md frontmatter. */
export function parseSkillMeta(raw: string): { name?: string; description?: string } {
  const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^(name|description):\s*(.*)$/);
    if (!mm) continue;
    const val = unquote(mm[2].trim());
    if (mm[1] === 'name') out.name = val;
    else if (mm[1] === 'description') out.description = val;
  }
  return out;
}

/** Pick a unique placeholder name for a new skill (`my-skill`, `my-skill-2`, …). */
export function uniqueSkillName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function newSkillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Describe when the agent should use this skill',
    '---',
    '',
    '(write the skill instructions / steps / playbook here)',
    '',
  ].join('\n');
}

export async function listSkills(): Promise<SkillMeta[]> {
  const dir = collectionDir();
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue;
    let description: string | undefined;
    try {
      const raw = await fs.promises.readFile(skillFile(entry.name), 'utf-8');
      description = parseSkillMeta(raw).description;
    } catch {
      continue; // no SKILL.md → not a skill folder
    }
    out.push({
      name: entry.name,
      ...(description ? { description } : {}),
      ...(isSkillLocked(entry.name) ? { locked: true } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getSkill(name: string): Promise<string | null> {
  if (!isValidSkillName(name)) return null;
  try {
    return await fs.promises.readFile(skillFile(name), 'utf-8');
  } catch {
    return null;
  }
}

/** Whether the skill is locked against AGENT edits (presence of its `.locked`
 *  marker). Synchronous — the bridge gates an update on it before writing. */
export function isSkillLocked(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  return fs.existsSync(lockMarkerPath(name));
}

/** Set/clear a skill's lock. No-op for an invalid name or a skill that doesn't
 *  exist (can't lock what isn't there). */
export async function setSkillLocked(name: string, locked: boolean): Promise<void> {
  if (!isValidSkillName(name) || !fs.existsSync(skillDir(name))) return;
  if (locked) await fs.promises.writeFile(lockMarkerPath(name), '');
  else await fs.promises.rm(lockMarkerPath(name), { force: true });
}

/** Materialise a new skill from the template under a unique placeholder name. */
export async function createSkill(): Promise<SkillMeta> {
  ensureScaffold();
  const existing = new Set((await listSkills()).map((s) => s.name));
  const name = uniqueSkillName('my-skill', existing);
  await fs.promises.mkdir(skillDir(name), { recursive: true });
  await fs.promises.writeFile(skillFile(name), newSkillTemplate(name), 'utf-8');
  return { name };
}

/**
 * Write `content` verbatim. The frontmatter `name` is the identity: if it
 * differs from `currentName`, the folder is renamed to match (collision-checked,
 * resources moved with it). Returns the resulting name, or an error.
 */
export async function updateSkill(currentName: string, content: string): Promise<SkillUpdateResult> {
  ensureScaffold();
  if (!isValidSkillName(currentName)) return { ok: false, error: 'Invalid current skill name' };

  // Reject frontmatter Copilot can't parse BEFORE writing — otherwise the skill
  // loads under Claude but silently vanishes under Copilot. See #80 / GOTCHAS.
  const yamlError = validateFrontmatterYaml(content);
  if (yamlError) return { ok: false, error: yamlError };

  const parsed = parseSkillMeta(content);
  const nextName = parsed.name?.trim();
  if (!nextName) return { ok: false, error: 'SKILL.md needs a `name:` in its frontmatter' };
  if (!isValidSkillName(nextName)) {
    return { ok: false, error: `Skill name must be lowercase kebab-case (got "${nextName}")` };
  }

  if (nextName === currentName) {
    await fs.promises.mkdir(skillDir(currentName), { recursive: true });
    await fs.promises.writeFile(skillFile(currentName), content, 'utf-8');
    return { ok: true, name: currentName };
  }

  // Rename: move the whole folder (carries reference.md / scripts/ etc.).
  if (fs.existsSync(skillDir(nextName))) {
    return { ok: false, error: `A skill named "${nextName}" already exists` };
  }
  try {
    if (fs.existsSync(skillDir(currentName))) {
      await fs.promises.rename(skillDir(currentName), skillDir(nextName));
    } else {
      await fs.promises.mkdir(skillDir(nextName), { recursive: true });
    }
    await fs.promises.writeFile(skillFile(nextName), content, 'utf-8');
    return { ok: true, name: nextName };
  } catch (err: any) {
    log.error('skills', `rename ${currentName} → ${nextName} failed: ${err?.message ?? err}`);
    return { ok: false, error: 'Failed to rename skill folder' };
  }
}

export async function deleteSkill(name: string): Promise<void> {
  if (!isValidSkillName(name)) return;
  await fs.promises.rm(skillDir(name), { recursive: true, force: true });
}

/**
 * Resolve a skill-folder-relative aux path to an absolute path INSIDE that
 * skill's folder, or null if the path is unusable: invalid skill name, blank,
 * absolute, a reserved file (SKILL.md / .locked), or escaping the folder (`..`).
 * The "resolved path is still within skillDir" check is authoritative — it
 * defends against every traversal trick, not just literal `..`. Pure (only path
 * math over skillDir) → unit-testable, and the single gate every aux op funnels
 * through. See contracts/app-tool-bridge.
 */
export function resolveAuxPath(name: string, rel: string): string | null {
  if (!isValidSkillName(name)) return null;
  if (typeof rel !== 'string') return null;
  const trimmed = rel.trim();
  if (!trimmed) return null;
  // Reject absolute, Windows drive-letter, and backslash separators outright.
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\')) return null;
  const dir = skillDir(name);
  const resolved = path.resolve(dir, trimmed);
  const relToDir = path.relative(dir, resolved);
  // Empty = the folder itself; `..`-prefixed / absolute = outside it.
  if (relToDir === '' || relToDir.startsWith('..') || path.isAbsolute(relToDir)) return null;
  if (RESERVED_AUX_FILES.has(relToDir)) return null;
  return resolved;
}

/** List a skill's aux files (everything except SKILL.md / .locked) as sorted,
 *  POSIX-relative paths. Empty for an unknown/invalid skill. */
export async function listSkillAuxFiles(name: string): Promise<string[]> {
  if (!isValidSkillName(name)) return [];
  const dir = skillDir(name);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = async (cur: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(cur, e.name), childRel);
      else if (e.isFile() && !RESERVED_AUX_FILES.has(childRel)) out.push(childRel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/** Read one aux file as utf-8. null = invalid/reserved path OR file absent (the
 *  bridge distinguishes them via `resolveAuxPath` for the error message). */
export async function readSkillFile(name: string, rel: string): Promise<string | null> {
  const abs = resolveAuxPath(name, rel);
  if (!abs) return null;
  try {
    return await fs.promises.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
}

/** Create/overwrite one aux file (utf-8), making parent dirs as needed. The path
 *  guard + skill-exists check are re-asserted here so the store is safe even if a
 *  caller skips the bridge guards. */
export async function writeSkillFile(name: string, rel: string, content: string): Promise<SkillFileResult> {
  const abs = resolveAuxPath(name, rel);
  if (!abs) return { ok: false, error: `Invalid or reserved skill file path: ${rel}` };
  if (!fs.existsSync(skillDir(name))) return { ok: false, error: `skill not found: ${name}` };
  try {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, 'utf-8');
    return { ok: true };
  } catch (err: any) {
    log.error('skills', `write aux ${name}/${rel} failed: ${err?.message ?? err}`);
    return { ok: false, error: 'Failed to write skill file' };
  }
}

/** Delete one aux file. Cannot touch SKILL.md / .locked (reserved → guard null). */
export async function deleteSkillFile(name: string, rel: string): Promise<SkillFileResult> {
  const abs = resolveAuxPath(name, rel);
  if (!abs) return { ok: false, error: `Invalid or reserved skill file path: ${rel}` };
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `file not found: ${rel}` };
    await fs.promises.rm(abs, { force: true });
    return { ok: true };
  } catch (err: any) {
    log.error('skills', `delete aux ${name}/${rel} failed: ${err?.message ?? err}`);
    return { ok: false, error: 'Failed to delete skill file' };
  }
}
