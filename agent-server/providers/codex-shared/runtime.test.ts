import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  codexConfigHome,
  codexEnv,
  codexNativeExecutable,
  codexNativePackageNameForHost,
  codexNativeVendorTriple,
  resolveCodexCliCommand,
  resolveCodexCliEntry,
  resolveCodexNativeExecutable,
} from './runtime';

describe('shared Codex app home/env', () => {
  it('names the per-app CODEX_HOME when an appId is present', () => {
    expect(codexConfigHome('app-42')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-42', 'codex'));
  });

  it('returns undefined without app context', () => {
    expect(codexConfigHome(undefined)).toBeUndefined();
  });

  it('sets CODEX_HOME to the per-app config-home, preserving the base env', () => {
    const env = codexEnv('app-42', { PATH: '/usr/bin' });
    expect(env.CODEX_HOME).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-42', 'codex'));
    expect(env.PATH).toBe('/usr/bin');
  });

  it('returns the base env unchanged without app context', () => {
    const base = { PATH: '/usr/bin' };
    const env = codexEnv(undefined, base);
    expect(env).toBe(base);
    expect(env.CODEX_HOME).toBeUndefined();
  });
});

describe('shared Codex CLI/runtime resolution', () => {
  const origCli = process.env.SHELF_CODEX_CLI_PATH;
  const origNative = process.env.SHELF_CODEX_NATIVE_PATH;

  afterEach(() => {
    if (origCli === undefined) delete process.env.SHELF_CODEX_CLI_PATH;
    else process.env.SHELF_CODEX_CLI_PATH = origCli;
    if (origNative === undefined) delete process.env.SHELF_CODEX_NATIVE_PATH;
    else process.env.SHELF_CODEX_NATIVE_PATH = origNative;
  });

  it('prefers the SHELF_CODEX_CLI_PATH override when it exists', () => {
    process.env.SHELF_CODEX_CLI_PATH = '/override/openai-codex/bin/codex.js';
    expect(resolveCodexCliEntry((p) => p === '/override/openai-codex/bin/codex.js')).toBe(
      '/override/openai-codex/bin/codex.js',
    );
  });

  it('wraps the resolved CLI entry as a node/electron command', () => {
    expect(resolveCodexCliCommand(() => '/x/bin/codex.js')).toEqual({
      command: process.execPath,
      args: ['/x/bin/codex.js'],
    });
  });

  it('throws loudly when the CLI entry cannot be resolved', () => {
    expect(() => resolveCodexCliCommand(() => undefined)).toThrow(/codex CLI not found/);
  });

  it('resolves the installed native executable path without PATH fallback', () => {
    const pkg = codexNativePackageNameForHost();
    const triple = codexNativeVendorTriple();
    const expected = path.join('node_modules', pkg, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    const resolved = codexNativeExecutable((p) => p.endsWith(expected));
    expect(resolved).toBeDefined();
    expect(resolved!.endsWith(expected)).toBe(true);
  });

  it('prefers SHELF_CODEX_NATIVE_PATH for the native executable when it exists', () => {
    process.env.SHELF_CODEX_NATIVE_PATH = '/override/codex';
    expect(codexNativeExecutable((p) => p === '/override/codex')).toBe('/override/codex');
  });

  it('throws loudly when the native executable cannot be resolved', () => {
    expect(codexNativeExecutable(() => false)).toBeUndefined();
    expect(() => resolveCodexNativeExecutable(() => undefined)).toThrow(/codex native executable not found/);
  });

  it('classifies unsupported native host triples explicitly', () => {
    expect(() => codexNativePackageNameForHost('aix', 'x64')).toThrow(/Unsupported Codex native platform/);
    expect(() => codexNativeVendorTriple('linux', 'ia32')).toThrow(/Unsupported Codex native platform/);
  });
});
