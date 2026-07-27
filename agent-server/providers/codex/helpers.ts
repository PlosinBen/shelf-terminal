// Codex ACP-specific helpers (pure / resolution only). First-party Codex
// runtime/auth/home helpers shared with the official SDK provider live in
// providers/codex-shared/.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  codexConfigHome,
  codexEnv,
  resolveCodexCliCommand,
  resolveCodexCliEntry,
  type CodexCommand,
} from '../codex-shared/runtime';

/** Command + args to launch a codex JS entry (codex-acp adapter or `codex` CLI). */
export type CodexAcpCommand = CodexCommand;
export { codexConfigHome, resolveCodexCliCommand, resolveCodexCliEntry };

// Both entries are shipped adjacent under a preserved `node_modules` tree so that
// codex-acp's `require.resolve("@openai/codex/bin/codex.js")` (and, in turn,
// bin/codex.js's `require.resolve("@openai/codex-<platform>/package.json")`)
// resolve as sibling packages — see package.json `extraResources` (`codex-cli/`).
const CODEX_ACP_ENTRY = path.join('node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');

/**
 * First existing candidate for a `codex-cli/` JS entry, tried in order:
 *   env override → packaged extraResources (`<Resources>/codex-cli/…`, relative to
 *   the agent-server bundle `__dirname`) → remote self-contained deploy
 *   (`<root>/codex-cli/…` next to index.mjs) → dev `node_modules` via require.resolve.
 * `exists` is injectable for tests. Undefined if nothing resolves.
 */
function resolveCodexEntry(
  rel: string,
  envOverride: string | undefined,
  devSpecifier: string,
  exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
  const candidates = [
    envOverride,
    // Packaged (Electron): extraResources/codex-cli/… (bundle at agent-server/<version>/).
    path.resolve(__dirname, '..', '..', 'codex-cli', rel),
    // Remote self-contained deploy: codex-cli/ sits next to index.mjs.
    path.resolve(__dirname, 'codex-cli', rel),
  ].filter((p): p is string => !!p);
  for (const c of candidates) if (exists(c)) return c;
  try {
    // Dev: resolve from node_modules relative to the source tree.
    return createRequire(__filename).resolve(devSpecifier);
  } catch {
    return undefined;
  }
}

/** Path to `@agentclientprotocol/codex-acp`'s `dist/index.js`. */
export function resolveCodexAcpEntry(exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return resolveCodexEntry(CODEX_ACP_ENTRY, process.env.SHELF_CODEX_ACP_PATH, '@agentclientprotocol/codex-acp', exists);
}

/**
 * How to launch `@agentclientprotocol/codex-acp` (the ACP agent) over stdio — its
 * bundled entry run with the current Node/Electron. Throws loudly if not found.
 */
export function resolveCodexAcpCommand(findEntry: () => string | undefined = resolveCodexAcpEntry): CodexAcpCommand {
  const entry = findEntry();
  if (!entry) {
    throw new Error(
      'codex-acp not found: expected @agentclientprotocol/codex-acp (dev) or extraResources/codex-cli (packaged)',
    );
  }
  return { command: process.execPath, args: [entry] };
}

/**
 * Spawn env for codex-acp / `codex app-server` login: base env + `CODEX_HOME` when
 * an app context exists (device-scoped auth isolation — Shelf hands only a PATH; the
 * CLI owns its opaque credentials there). Returns `base` unchanged without appId.
 */
export function codexAcpEnv(
  appId: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return codexEnv(appId, base);
}

/** The per-app codex home, doubling as the ACP additionalDirectory root whose
 *  `.agents/skills` codex-acp scans. Same path as {@link codexConfigHome}. */
export function codexSkillsRoot(appId: string | undefined): string | undefined {
  return codexConfigHome(appId);
}

/**
 * Where codex-acp scans for app-level skills, for `appId`:
 * `<codexSkillsRoot>/.agents/skills`. codex-acp appends `.agents/skills` to each
 * ACP `additionalDirectory` (verified in its `refreshSkills` source). The provider
 * declares this; the agent-server projects the canonical skill tree here (the
 * backend does no fs — provider-boundary principle). Undefined without app context.
 */
export function codexSkillTarget(appId: string | undefined): string | undefined {
  const root = codexSkillsRoot(appId);
  return root ? path.join(root, '.agents', 'skills') : undefined;
}
