// Shared first-party Codex runtime primitives.
//
// This module owns Codex concepts that are common to both Shelf's legacy
// codex-acp provider and the temporary app-server provider: app-scoped
// CODEX_HOME, the official CLI entry, and the native `codex` executable path.
// ACP-specific adapter entry and ACP skill scan conventions stay in
// providers/codex/.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { CODEX_PROVIDER } from '@shared/agent-providers';

/** Command + args to launch a Codex JS entry. */
export interface CodexCommand {
  command: string;
  args: string[];
}

const CODEX_CLI_ENTRY = path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js');

/**
 * `CODEX_HOME` for this app instance: `~/.shelf/apps/<appId>/codex`. Codex reads
 * auth/config/sessions here, so per-app means per-device auth isolation.
 * Undefined without app context.
 */
export function codexConfigHome(appId: string | undefined): string | undefined {
  if (!appId) return undefined;
  return path.join(os.homedir(), '.shelf', 'apps', appId, CODEX_PROVIDER);
}

/**
 * Spawn env for Codex CLI/SDK children: base env + `CODEX_HOME` when an app
 * context exists. Returns `base` unchanged without appId.
 */
export function codexEnv(
  appId: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = codexConfigHome(appId);
  return home ? { ...base, CODEX_HOME: home } : base;
}

/**
 * First existing candidate for a `codex-cli/` JS entry, tried in order:
 * env override → packaged extraResources → remote self-contained deploy → dev
 * `node_modules` via require.resolve. Undefined if nothing resolves.
 */
export function resolveCodexCliEntry(exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const direct = resolveCodexPackagedEntry(CODEX_CLI_ENTRY, process.env.SHELF_CODEX_CLI_PATH, exists);
  if (direct) return direct;
  try {
    const pkgJson = createRequire(__filename).resolve('@openai/codex/package.json');
    const entry = path.join(path.dirname(pkgJson), 'bin', 'codex.js');
    return exists(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How to launch the `codex` JS CLI itself (`codex app-server`, debug commands).
 * Throws loudly if not found; Codex must not silently fall back to PATH.
 */
export function resolveCodexCliCommand(findEntry: () => string | undefined = resolveCodexCliEntry): CodexCommand {
  const entry = findEntry();
  if (!entry) {
    throw new Error(
      'codex CLI not found: expected @openai/codex/bin/codex.js (dev) or extraResources/codex-cli (packaged)',
    );
  }
  return { command: process.execPath, args: [entry] };
}

/** Optional native executable path from the pinned Codex package; never uses PATH. */
export function codexNativeExecutable(exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const binName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const rel = path.join('node_modules', codexNativePackageNameForHost(), 'vendor', codexNativeVendorTriple(), 'bin', binName);
  const direct = resolveCodexPackagedEntry(rel, process.env.SHELF_CODEX_NATIVE_PATH, exists);
  if (direct) return direct;
  try {
    const pkgJson = createRequire(__filename).resolve(`${codexNativePackageNameForHost()}/package.json`);
    const entry = path.join(path.dirname(pkgJson), 'vendor', codexNativeVendorTriple(), 'bin', binName);
    return exists(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Throwing variant for production code paths that require the pinned native Codex binary. */
export function resolveCodexNativeExecutable(
  findEntry: () => string | undefined = codexNativeExecutable,
): string {
  const entry = findEntry();
  if (!entry) {
    throw new Error(
      `codex native executable not found for ${process.platform}/${process.arch}: expected @openai/codex native package (dev) or extraResources/codex-cli (packaged)`,
    );
  }
  return entry;
}

export function codexNativePackageNameForHost(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  if (platform === 'darwin' && arch === 'arm64') return '@openai/codex-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return '@openai/codex-darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return '@openai/codex-linux-arm64';
  if (platform === 'linux' && arch === 'x64') return '@openai/codex-linux-x64';
  if (platform === 'win32' && arch === 'arm64') return '@openai/codex-win32-arm64';
  if (platform === 'win32' && arch === 'x64') return '@openai/codex-win32-x64';
  throw new Error(`Unsupported Codex native platform: ${platform}/${arch}`);
}

export function codexNativeVendorTriple(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-musl';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-musl';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`Unsupported Codex native platform: ${platform}/${arch}`);
}

function resolveCodexPackagedEntry(
  rel: string,
  envOverride: string | undefined,
  exists: (p: string) => boolean,
): string | undefined {
  const candidates = [
    envOverride,
    // Packaged (Electron): extraResources/codex-cli/… (bundle at agent-server/<version>/).
    path.resolve(__dirname, '..', '..', 'codex-cli', rel),
    // Remote self-contained deploy: codex-cli/ sits next to index.mjs.
    path.resolve(__dirname, 'codex-cli', rel),
  ].filter((p): p is string => !!p);
  for (const c of candidates) if (exists(c)) return c;
  return undefined;
}
