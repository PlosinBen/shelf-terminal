import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/unused' } }));

const { validateSkillPayload } = await import('./validation');

let root: string;

function seedSkill(name: string, skillMarkdown?: string): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    skillMarkdown ?? `---\nname: ${name}\ndescription: test\n---\n# ${name}\n`,
  );
  return directory;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-validation-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('validateSkillPayload', () => {
  it('returns the exact regular-file allowlist and excludes Shelf control markers', () => {
    const directory = seedSkill('demo');
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.writeFileSync(path.join(directory, 'scripts', 'run.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(directory, '.locked'), '');
    fs.writeFileSync(path.join(directory, '.disabled'), '');

    expect(validateSkillPayload('demo', directory)).toEqual({
      valid: true,
      payloadFiles: ['SKILL.md', 'scripts/run.sh'],
    });
  });

  it('rejects invalid YAML and a frontmatter name that disagrees with the folder', () => {
    const invalidYaml = seedSkill('bad-yaml', '---\nname: bad-yaml\ndescription: bad: value\n---\n');
    expect(validateSkillPayload('bad-yaml', invalidYaml)).toMatchObject({ valid: false });

    const mismatch = seedSkill('folder-name', '---\nname: other-name\n---\n');
    expect(validateSkillPayload('folder-name', mismatch)).toEqual({
      valid: false,
      reason: 'SKILL.md name "other-name" does not match folder "folder-name"',
    });
  });

  it('rejects symlinks instead of following content outside the Skill', () => {
    const directory = seedSkill('linked');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(directory, 'outside-link'));

    expect(validateSkillPayload('linked', directory)).toEqual({
      valid: false,
      reason: 'Symlinks are not supported: outside-link',
    });
  });

  it('requires a regular UTF-8 SKILL.md', () => {
    const missing = path.join(root, 'missing-md');
    fs.mkdirSync(missing);
    expect(validateSkillPayload('missing-md', missing)).toEqual({
      valid: false,
      reason: 'SKILL.md is required',
    });

    const binary = seedSkill('binary-md');
    fs.writeFileSync(path.join(binary, 'SKILL.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    expect(validateSkillPayload('binary-md', binary)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('valid UTF-8'),
    });
  });
});
