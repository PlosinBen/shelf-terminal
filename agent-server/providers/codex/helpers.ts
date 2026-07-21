// Codex-specific helpers (pure / resolution only). Codex SEMANTICS that differ
// from other ACP agents live here, NOT in the shared acp/ toolkit.

import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

/** Command + args to launch the codex-acp ACP agent over stdio. */
export interface CodexAcpCommand {
  command: string;
  args: string[];
}

/**
 * Resolve how to launch the `codex` CLI itself (for `codex app-server`, used by
 * the device-code login drive). Dev: the `@openai/codex` package's `bin/codex.js`
 * shim, run with the current Node. Packaged: `SHELF_CODEX_CLI_PATH` (Phase 3).
 */
export function resolveCodexCliCommand(): CodexAcpCommand {
  const packaged = process.env.SHELF_CODEX_CLI_PATH;
  if (packaged) return { command: process.execPath, args: [packaged] };
  const require = createRequire(__filename);
  const pkgJson = require.resolve('@openai/codex/package.json');
  const entry = path.join(path.dirname(pkgJson), 'bin', 'codex.js');
  return { command: process.execPath, args: [entry] };
}

/**
 * Resolve how to launch `@agentclientprotocol/codex-acp`.
 *
 * Dev / unpacked: run its bundled entry with the current Node. Packaged: Phase 3
 * ships it under extraResources (like the Copilot CLI) and sets
 * `SHELF_CODEX_ACP_PATH`. Throws loudly if neither is available — codex must not
 * silently fall back.
 */
export function resolveCodexAcpCommand(): CodexAcpCommand {
  const packaged = process.env.SHELF_CODEX_ACP_PATH;
  if (packaged) return { command: process.execPath, args: [packaged] };
  try {
    const require = createRequire(__filename);
    const entry = require.resolve('@agentclientprotocol/codex-acp');
    return { command: process.execPath, args: [entry] };
  } catch {
    throw new Error(
      'codex-acp not found: install @agentclientprotocol/codex-acp (dev) or set SHELF_CODEX_ACP_PATH (packaged)',
    );
  }
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
