import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}));

const {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill,
  parseSkillMeta, isValidSkillName, uniqueSkillName,
  isSkillLocked, setSkillLocked, validateFrontmatterYaml,
} = await import('./skills-store');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-skills-store-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pure helpers', () => {
  it('parseSkillMeta reads name + description (quoted or bare)', () => {
    const raw = '---\nname: kibana-connect\ndescription: "how to reach kibana"\n---\n\nbody';
    expect(parseSkillMeta(raw)).toEqual({ name: 'kibana-connect', description: 'how to reach kibana' });
  });
  it('parseSkillMeta returns {} when no frontmatter', () => {
    expect(parseSkillMeta('just text')).toEqual({});
  });
  it('isValidSkillName enforces kebab-case', () => {
    expect(isValidSkillName('kibana-connect')).toBe(true);
    expect(isValidSkillName('a1-b2')).toBe(true);
    expect(isValidSkillName('Kibana')).toBe(false); // uppercase
    expect(isValidSkillName('has space')).toBe(false);
    expect(isValidSkillName('-leading')).toBe(false);
    expect(isValidSkillName('trailing-')).toBe(false);
    expect(isValidSkillName('a/b')).toBe(false);
    expect(isValidSkillName('..')).toBe(false);
  });
  it('uniqueSkillName suffixes on collision', () => {
    expect(uniqueSkillName('my-skill', new Set())).toBe('my-skill');
    expect(uniqueSkillName('my-skill', new Set(['my-skill']))).toBe('my-skill-2');
    expect(uniqueSkillName('my-skill', new Set(['my-skill', 'my-skill-2']))).toBe('my-skill-3');
  });

  it('validateFrontmatterYaml: valid frontmatter (bare + quoted) → null', () => {
    expect(validateFrontmatterYaml('---\nname: a\ndescription: plain desc\n---\nbody')).toBeNull();
    expect(validateFrontmatterYaml('---\nname: a\ndescription: "has a: colon"\n---\nbody')).toBeNull();
  });
  it('validateFrontmatterYaml: no frontmatter block → null (name check handles it)', () => {
    expect(validateFrontmatterYaml('just a body, no frontmatter')).toBeNull();
  });
  it('validateFrontmatterYaml: unquoted colon-space in a value → error (the Copilot-skip hazard)', () => {
    // The real bug: `conventions: folder` mid-value breaks strict YAML.
    const bad = '---\nname: a\ndescription: uses conventions: folder categories here\n---\nbody';
    const err = validateFrontmatterYaml(bad);
    expect(err).toMatch(/not valid YAML/i);
    expect(err).toMatch(/double quotes/i);
  });
  it('validateFrontmatterYaml: a colon WITHOUT a following space (e.g. a URL) is valid YAML', () => {
    expect(validateFrontmatterYaml('---\nname: a\ndescription: see https://x.test/y\n---\nbody')).toBeNull();
  });
});

describe('CRUD + scaffold', () => {
  it('create materialises a skill + plugin scaffold; list shows it', async () => {
    const created = await createSkill();
    expect(created.name).toBe('my-skill');
    // plugin.json scaffold exists (projection-ready)
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'skills', '.claude-plugin', 'plugin.json'), 'utf-8'));
    expect(manifest.name).toBe('shelf-skills');
    const list = await listSkills();
    expect(list.map((s) => s.name)).toEqual(['my-skill']);
  });

  it('create twice yields unique placeholder names', async () => {
    await createSkill();
    const second = await createSkill();
    expect(second.name).toBe('my-skill-2');
  });

  it('get returns raw verbatim content', async () => {
    await createSkill();
    const raw = await getSkill('my-skill');
    expect(raw).toContain('name: my-skill');
    expect(raw).toContain('(write the skill instructions');
  });

  it('update in place keeps name; list reflects new description', async () => {
    await createSkill();
    const r = await updateSkill('my-skill', '---\nname: my-skill\ndescription: updated desc\n---\n\nbody');
    expect(r).toEqual({ ok: true, name: 'my-skill' });
    expect((await listSkills())[0].description).toBe('updated desc');
  });

  it('update with a new name renames the folder', async () => {
    await createSkill();
    const r = await updateSkill('my-skill', '---\nname: kibana-connect\ndescription: d\n---\n\nbody');
    expect(r).toEqual({ ok: true, name: 'kibana-connect' });
    expect((await listSkills()).map((s) => s.name)).toEqual(['kibana-connect']);
    expect(await getSkill('my-skill')).toBeNull();
  });

  it('rename carries sibling resources in the folder', async () => {
    await createSkill();
    // skill folders live at <userData>/skills/skills/<name>/ (the inner `skills`
    // is the plugin's skills/ dir; the outer is the plugin root).
    fs.writeFileSync(path.join(tmpDir, 'skills', 'skills', 'my-skill', 'reference.md'), 'ref');
    await updateSkill('my-skill', '---\nname: renamed\ndescription: d\n---\n');
    expect(fs.readFileSync(path.join(tmpDir, 'skills', 'skills', 'renamed', 'reference.md'), 'utf-8')).toBe('ref');
  });

  it('rename onto an existing name is rejected', async () => {
    await createSkill(); // my-skill
    await updateSkill('my-skill', '---\nname: alpha\ndescription: d\n---\n'); // → alpha
    const beta = await createSkill(); // my-skill again
    const r = await updateSkill(beta.name, '---\nname: alpha\ndescription: d\n---\n');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/);
  });

  it('update rejects missing / invalid frontmatter name', async () => {
    await createSkill();
    expect((await updateSkill('my-skill', 'no frontmatter')).ok).toBe(false);
    expect((await updateSkill('my-skill', '---\nname: Bad Name\n---\n')).ok).toBe(false);
  });

  it('update rejects invalid-YAML frontmatter (Copilot-skip hazard) and does NOT write it', async () => {
    await createSkill();
    const good = '---\nname: my-skill\ndescription: original\n---\n\nbody';
    await updateSkill('my-skill', good);
    // Unquoted colon-space — valid to the lenient regex, invalid to strict YAML.
    const bad = '---\nname: my-skill\ndescription: uses conventions: folder categories\n---\n\nnew body';
    const r = await updateSkill('my-skill', bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid YAML/i);
    // The on-disk file must be untouched (last good content preserved).
    expect(await getSkill('my-skill')).toBe(good);
  });

  it('delete removes the skill', async () => {
    await createSkill();
    await deleteSkill('my-skill');
    expect(await listSkills()).toEqual([]);
  });

  it('list is empty (not error) before any skill exists', async () => {
    expect(await listSkills()).toEqual([]);
  });
});

describe('lock', () => {
  it('defaults unlocked; setSkillLocked(true) locks, list reflects it', async () => {
    await createSkill();
    expect(isSkillLocked('my-skill')).toBe(false);
    expect((await listSkills())[0].locked).toBeUndefined();
    await setSkillLocked('my-skill', true);
    expect(isSkillLocked('my-skill')).toBe(true);
    expect((await listSkills())[0].locked).toBe(true);
  });

  it('setSkillLocked(false) unlocks', async () => {
    await createSkill();
    await setSkillLocked('my-skill', true);
    await setSkillLocked('my-skill', false);
    expect(isSkillLocked('my-skill')).toBe(false);
  });

  it('the lock survives a rename (marker lives in the folder)', async () => {
    await createSkill();
    await setSkillLocked('my-skill', true);
    await updateSkill('my-skill', '---\nname: renamed\ndescription: d\n---\n');
    expect(isSkillLocked('renamed')).toBe(true);
  });

  it('locking a non-existent skill is a no-op (cannot lock what is not there)', async () => {
    await setSkillLocked('ghost', true);
    expect(isSkillLocked('ghost')).toBe(false);
  });
});
