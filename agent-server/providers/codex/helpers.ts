// Codex-specific helpers (pure / resolution only). Codex SEMANTICS that differ
// from other ACP agents live here, NOT in the shared acp/ toolkit.

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';

/** Command + args to launch a codex JS entry (codex-acp adapter or `codex` CLI). */
export interface CodexAcpCommand {
  command: string;
  args: string[];
}

// Both entries are shipped adjacent under a preserved `node_modules` tree so that
// codex-acp's `require.resolve("@openai/codex/bin/codex.js")` (and, in turn,
// bin/codex.js's `require.resolve("@openai/codex-<platform>/package.json")`)
// resolve as sibling packages — see package.json `extraResources` (`codex-cli/`).
const CODEX_ACP_ENTRY = path.join('node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
const CODEX_CLI_ENTRY = path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js');

/**
 * First existing candidate for a `codex-cli/` JS entry, tried in order:
 *   env override → packaged extraResources (`<Resources>/codex-cli/…`, relative to
 *   the agent-server bundle `__dirname`) → remote self-contained deploy
 *   (`<root>/codex-cli/…` next to index.mjs) → dev `node_modules` via require.resolve.
 * `exists` + `devResolve` are injectable for tests. Undefined if nothing resolves.
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

/** Path to `@openai/codex/bin/codex.js` (dev resolves via package.json → bin). */
export function resolveCodexCliEntry(exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const direct = resolveCodexEntry(CODEX_CLI_ENTRY, process.env.SHELF_CODEX_CLI_PATH, '@openai/codex/bin/codex.js', exists);
  if (direct) return direct;
  try {
    const pkgJson = createRequire(__filename).resolve('@openai/codex/package.json');
    const entry = path.join(path.dirname(pkgJson), 'bin', 'codex.js');
    return exists(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Path to `@agentclientprotocol/codex-acp`'s `dist/index.js`. */
export function resolveCodexAcpEntry(exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return resolveCodexEntry(CODEX_ACP_ENTRY, process.env.SHELF_CODEX_ACP_PATH, '@agentclientprotocol/codex-acp', exists);
}

/**
 * How to launch the `codex` CLI itself (for `codex app-server`, used by the
 * device-code login drive) — the JS entry run with the current Node/Electron.
 * Throws loudly if not found; codex must not silently fall back.
 */
export function resolveCodexCliCommand(findEntry: () => string | undefined = resolveCodexCliEntry): CodexAcpCommand {
  const entry = findEntry();
  if (!entry) {
    throw new Error(
      'codex CLI not found: expected @openai/codex/bin/codex.js (dev) or extraResources/codex-cli (packaged)',
    );
  }
  return { command: process.execPath, args: [entry] };
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
 * The per-app root to hand codex-acp as an ACP `additionalDirectory`. codex-acp
 * appends `.agents/skills`, so projecting Shelf skills to
 * `<root>/.agents/skills/<name>/SKILL.md` makes them discoverable. Returns
 * undefined when there is no app context. (Projection itself is a later task;
 * this only computes the path contract.)
 */
/**
 * `CODEX_HOME` for this app instance: `~/.shelf/apps/<appId>/codex`. codex reads
 * auth / config / sessions here → per-app = per-device auth isolation (AUTH =
 * DEVICE-SCOPED; see the copilot-acp feature note). This SAME dir is also the ACP
 * `additionalDirectory` whose `.agents/skills` codex-acp scans (see codexSkillTarget)
 * — the two roles don't collide (different subpaths). Undefined without app context.
 */
export function codexConfigHome(appId: string | undefined): string | undefined {
  if (!appId) return undefined;
  return path.join(os.homedir(), '.shelf', 'apps', appId, 'codex');
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
  const home = codexConfigHome(appId);
  return home ? { ...base, CODEX_HOME: home } : base;
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
