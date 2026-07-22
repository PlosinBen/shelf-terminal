import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  codexConfigHome,
  codexAcpEnv,
  codexSkillsRoot,
  codexSkillTarget,
  resolveCodexAcpEntry,
  resolveCodexAcpCommand,
  resolveCodexCliCommand,
} from './helpers';

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

describe('codex entry resolution (packaging)', () => {
  const origAcp = process.env.SHELF_CODEX_ACP_PATH;
  afterEach(() => {
    if (origAcp === undefined) delete process.env.SHELF_CODEX_ACP_PATH;
    else process.env.SHELF_CODEX_ACP_PATH = origAcp;
  });

  it('prefers the SHELF_CODEX_ACP_PATH override when it exists', () => {
    process.env.SHELF_CODEX_ACP_PATH = '/override/codex-acp/dist/index.js';
    expect(resolveCodexAcpEntry((p) => p === '/override/codex-acp/dist/index.js')).toBe(
      '/override/codex-acp/dist/index.js',
    );
  });

  it('falls to the packaged extraResources codex-cli/ path when no override', () => {
    delete process.env.SHELF_CODEX_ACP_PATH;
    const packagedTail = path.join('codex-cli', 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
    const entry = resolveCodexAcpEntry((p) => p.endsWith(packagedTail));
    expect(entry).toBeDefined();
    expect(entry!.endsWith(packagedTail)).toBe(true);
  });

  it('wraps the resolved entry as a node/electron command', () => {
    expect(resolveCodexAcpCommand(() => '/x/dist/index.js')).toEqual({
      command: process.execPath,
      args: ['/x/dist/index.js'],
    });
    expect(resolveCodexCliCommand(() => '/x/bin/codex.js')).toEqual({
      command: process.execPath,
      args: ['/x/bin/codex.js'],
    });
  });

  it('throws loudly when the entry cannot be resolved (no silent fallback)', () => {
    expect(() => resolveCodexAcpCommand(() => undefined)).toThrow(/codex-acp not found/);
    expect(() => resolveCodexCliCommand(() => undefined)).toThrow(/codex CLI not found/);
  });
});
