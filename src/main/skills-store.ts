import path from 'path';
import fs from 'fs';
import { app } from 'electron';
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
}

export interface SkillUpdateResult {
  ok: boolean;
  /** The (possibly renamed) skill name on success. */
  name?: string;
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
function manifestPath(): string {
  return path.join(skillsRoot(), '.claude-plugin', 'plugin.json');
}

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
    out.push({ name: entry.name, ...(description ? { description } : {}) });
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
