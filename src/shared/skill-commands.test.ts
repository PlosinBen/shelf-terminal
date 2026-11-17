import { describe, expect, it } from 'vitest';
import {
  SKILL_COMMAND_VERSION, SKILL_COMMAND_FILE, isSkillCommandControlPath,
  parseShelfCommandPrefix, validateSkillCommandDraft, validateSkillCommandRegistration,
  validateSkillCommandCatalog, resolveSkillCommand, SKILL_COMMAND_RESOLUTION as R,
  type SkillCommandEntry,
} from './skill-commands';

const id = 'ad1b0c23-6789-4123-8123-123456789abc';
const entry: SkillCommandEntry = {
  skillName: 'development-flow', disabled: false,
  command: { version: SKILL_COMMAND_VERSION, registrationId: id, alias: 'dev-flow', description: 'Run workflow' },
};

describe('command metadata validation', () => {
  it('trims editable values without silently renaming an alias', () => {
    expect(validateSkillCommandDraft({ alias: ' dev-flow ', description: ' Workflow ' })).toEqual({ ok: true, value: { alias: 'dev-flow', description: 'Workflow' } });
    for (const alias of ['Dev-flow', '/flow', '', '-flow', 'a--b', 'a'.repeat(65)]) {
      expect(validateSkillCommandDraft({ alias, description: 'Workflow' }).ok).toBe(false);
    }
    for (const description of ['', 'a\nb', 'a\rb', 'a'.repeat(257)]) {
      expect(validateSkillCommandDraft({ alias: 'flow', description }).ok).toBe(false);
    }
  });

  it('rejects unknown versions, unknown fields and malformed identity', () => {
    for (const value of [null, [], {}, { ...entry.command, version: 2 }, { ...entry.command, enabled: true }, { ...entry.command, registrationId: 'bad' }]) {
      expect(validateSkillCommandRegistration(value).ok).toBe(false);
    }
    expect(validateSkillCommandRegistration({ ...entry.command, registrationId: id.toUpperCase() })).toEqual({ ok: true, value: entry.command });
  });

  it('includes disabled skills in alias/registration ID uniqueness checks', () => {
    const duplicate = { ...entry, skillName: 'other', disabled: true };
    expect(validateSkillCommandCatalog([entry, duplicate])).toMatch(/alias.*conflicts/);
    expect(validateSkillCommandCatalog([entry, { ...duplicate, command: { ...entry.command, alias: 'other' } }])).toMatch(/registration ID.*conflicts/);
  });
});

describe('provider-neutral command resolution', () => {
  it('recognizes hyphens and optional arguments without changing the input', () => {
    const content = '  /dev-flow\t task one  ';
    expect(parseShelfCommandPrefix(content)).toEqual({ alias: 'dev-flow', args: 'task one' });
    expect(parseShelfCommandPrefix('/dev-flow')).toEqual({ alias: 'dev-flow', args: '' });
    expect(content).toBe('  /dev-flow\t task one  ');
    expect(resolveSkillCommand(content, [entry], new Set())).toEqual({ kind: R.MATCH, skillName: entry.skillName, registrationId: id, alias: 'dev-flow', args: 'task one' });
  });

  it('preserves unknown/native/multiline inputs, and native commands win collisions', () => {
    for (const content of ['/unknown', '/shelf-skills:flow arg', 'normal text', '/dev-flow\nnext', '/dev-flow\rnext', '/dev-flow/other']) {
      expect(resolveSkillCommand(content, [entry], new Set())).toEqual({ kind: R.NONE });
    }
    expect(resolveSkillCommand('/dev-flow arg', [entry], new Set(['dev-flow']))).toEqual({ kind: R.NATIVE });
  });

  it('refuses disabled or conflicting Shelf targets', () => {
    expect(resolveSkillCommand('/dev-flow', [{ ...entry, disabled: true }], new Set()).kind).toBe(R.ERROR);
    expect(resolveSkillCommand('/dev-flow', [entry, { ...entry, skillName: 'other' }], new Set()).kind).toBe(R.ERROR);
  });
});


it('reserves case variants and native Windows descendants without hiding nested resources', () => {
  expect(isSkillCommandControlPath(SKILL_COMMAND_FILE.toUpperCase())).toBe(true);
  expect(isSkillCommandControlPath(String.raw`${SKILL_COMMAND_FILE}\child`)).toBe(true);
  expect(isSkillCommandControlPath(`references/${SKILL_COMMAND_FILE}`)).toBe(false);
});
