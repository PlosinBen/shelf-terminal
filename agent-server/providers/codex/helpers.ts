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
export function codexSkillsRoot(appId: string | undefined): string | undefined {
  if (!appId) return undefined;
  return path.join(os.homedir(), '.shelf', 'apps', appId, 'codex');
}
