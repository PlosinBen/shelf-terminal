import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexConfigHome, codexAcpEnv, codexSkillsRoot, codexSkillTarget } from './helpers';

describe('codexConfigHome', () => {
  it('names the per-app CODEX_HOME when an appId is present', () => {
    expect(codexConfigHome('app-42')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-42', 'codex'));
  });
  it('returns undefined without app context', () => {
    expect(codexConfigHome(undefined)).toBeUndefined();
  });
  it('the skills additionalDirectory root IS the config home; the scan target appends .agents/skills', () => {
    expect(codexSkillsRoot('app-42')).toBe(codexConfigHome('app-42'));
    expect(codexSkillTarget('app-42')).toBe(path.join(codexConfigHome('app-42')!, '.agents', 'skills'));
  });
});

describe('codexAcpEnv', () => {
  it('sets CODEX_HOME to the per-app config-home, preserving the base env', () => {
    const env = codexAcpEnv('app-42', { PATH: '/usr/bin' });
    expect(env.CODEX_HOME).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-42', 'codex'));
    expect(env.PATH).toBe('/usr/bin');
  });
  it('returns the base env unchanged (no CODEX_HOME) without app context', () => {
    const base = { PATH: '/usr/bin' };
    const env = codexAcpEnv(undefined, base);
    expect(env).toBe(base);
    expect(env.CODEX_HOME).toBeUndefined();
  });
});
