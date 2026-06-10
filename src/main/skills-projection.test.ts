import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let userDataDir: string;
let homeDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => homeDir }, homedir: () => homeDir };
});

const { projectSkillsLocal, localSkillsTarget, listSkillFilesRel, hashSkillsTree, skillsSourceRoot } = await import('./skills-projection');
const { getAppInstanceId } = await import('./app-instance-id');

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-skproj-ud-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-skproj-home-'));
});
afterEach(() => {
  for (const d of [userDataDir, homeDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
});

function seedSourceSkill(name: string, body: string) {
  const dir = path.join(userDataDir, 'skills', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  fs.mkdirSync(path.join(userDataDir, 'skills', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'skills', '.claude-plugin', 'plugin.json'), '{"name":"shelf-skills"}');
}

describe('getAppInstanceId', () => {
  it('generates a stable UUID persisted in userData', () => {
    const a = getAppInstanceId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    // cached within the run; the file exists
    expect(fs.existsSync(path.join(userDataDir, 'app-instance-id'))).toBe(true);
    expect(getAppInstanceId()).toBe(a);
  });
});

describe('projectSkillsLocal', () => {
  it('mirrors the source tree onto ~/.shelf/apps/<id>/skills', () => {
    seedSourceSkill('kibana-connect', 'ssh to bastion');
    projectSkillsLocal('app-123');
    const dst = localSkillsTarget('app-123');
    expect(dst).toBe(path.join(homeDir, '.shelf', 'apps', 'app-123', 'skills'));
    expect(fs.readFileSync(path.join(dst, 'skills', 'kibana-connect', 'SKILL.md'), 'utf-8')).toBe('ssh to bastion');
    expect(fs.existsSync(path.join(dst, '.claude-plugin', 'plugin.json'))).toBe(true);
    // Touches the app lease so the startup sweep doesn't reclaim the just-
    // projected dir before the first heartbeat (cleanup.ts interaction).
    expect(fs.existsSync(path.join(homeDir, '.shelf', 'apps', 'app-123', '.heartbeat'))).toBe(true);
  });

  it('is a mirror: deletes vanish from the target on re-projection', () => {
    seedSourceSkill('a', 'A');
    seedSourceSkill('b', 'B');
    projectSkillsLocal('app-1');
    // remove `b` from source, re-project
    fs.rmSync(path.join(userDataDir, 'skills', 'skills', 'b'), { recursive: true, force: true });
    projectSkillsLocal('app-1');
    const dst = localSkillsTarget('app-1');
    expect(fs.existsSync(path.join(dst, 'skills', 'a'))).toBe(true);
    expect(fs.existsSync(path.join(dst, 'skills', 'b'))).toBe(false);
  });

  it('no-ops when there is no source', () => {
    expect(() => projectSkillsLocal('app-x')).not.toThrow();
    expect(fs.existsSync(localSkillsTarget('app-x'))).toBe(false);
  });
});

describe('listSkillFilesRel + hashSkillsTree', () => {
  it('lists POSIX-relative file paths, sorted', () => {
    seedSourceSkill('beta', 'B');
    seedSourceSkill('alpha', 'A');
    const rels = listSkillFilesRel(skillsSourceRoot());
    expect(rels).toContain('skills/alpha/SKILL.md');
    expect(rels).toContain('skills/beta/SKILL.md');
    expect(rels).toContain('.claude-plugin/plugin.json');
    expect([...rels]).toEqual([...rels].sort()); // sorted
  });

  it('hash is stable across calls and changes with content', () => {
    seedSourceSkill('a', 'A');
    const h1 = hashSkillsTree(skillsSourceRoot());
    expect(hashSkillsTree(skillsSourceRoot())).toBe(h1); // stable
    seedSourceSkill('a', 'A-edited');
    expect(hashSkillsTree(skillsSourceRoot())).not.toBe(h1); // content change perturbs
  });
});
