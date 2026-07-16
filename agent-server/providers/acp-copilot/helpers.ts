// Copilot-ACP specifics (pure / resolution only). Copilot SEMANTICS that differ
// from the shared acp/ toolkit live here, NOT in the toolkit (mirrors
// codex/helpers.ts).
//
// TEMP scaffolding (copilot-acp feature, parallel phase): duplicates the copilot
// binary resolution so acp-copilot is self-contained and native `copilot` stays
// untouched. At cutover this becomes THE copilot resolver and native copilot's
// private resolveCopilotCliPath is retired.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Command + args to launch the `copilot` CLI in ACP mode over stdio. */
export interface CopilotAcpCommand {
  command: string;
  args: string[];
}

/**
 * Locate the STANDALONE `copilot` binary inside the per-platform package
 * `@github/copilot-<platform>-<arch>` (it is spawned directly over stdio — a
 * non-.js binary, so no node is needed). Same candidate list as native copilot's
 * resolveCopilotCliPath. Returns undefined when not found (caller fails loud). We
 * deliberately do NOT fall back to a global install — ship our own.
 */
export function resolveCopilotBinary(): string | undefined {
  const bin = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
  const pkgBin = path.join('@github', `copilot-${process.platform}-${process.arch}`, bin);
  const candidates = [
    // Remote self-contained deploy: standalone binary next to index.mjs.
    path.resolve(__dirname, 'copilot'),
    // Packaged: extraResources/copilot-cli/@github/copilot-<plat>-<arch>/copilot.
    path.resolve(__dirname, '..', '..', 'copilot-cli', pkgBin),
    // Dev: platform package under node_modules, relative to the bundle output.
    path.resolve(__dirname, '..', '..', '..', 'node_modules', pkgBin),
    // Dev: relative to project root (running unbundled via tsx/ts-node).
    path.resolve(__dirname, '..', '..', 'node_modules', pkgBin),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Resolve how to launch `copilot --acp`. `findBinary` is injectable for tests;
 * production uses {@link resolveCopilotBinary}. Throws loudly if the binary is
 * missing — copilot must not silently fall back.
 */
export function resolveCopilotAcpCommand(
  findBinary: () => string | undefined = resolveCopilotBinary,
): CopilotAcpCommand {
  const bin = findBinary();
  if (!bin) {
    throw new Error(
      'copilot CLI not found: expected the @github/copilot-<platform>-<arch> binary (dev) ' +
        'or extraResources/copilot-cli (packaged)',
    );
  }
  return { command: bin, args: ['--acp'] };
}

/**
 * The per-app root handed to `copilot --acp` as an ACP `additionalDirectory` so
 * Shelf's projected skills are discoverable. Mirrors the codex contract; the
 * exact sub-path copilot appends is a Phase-2 live detail. Returns undefined when
 * there is no app context.
 */
export function copilotAcpSkillsRoot(appId: string | undefined): string | undefined {
  if (!appId) return undefined;
  return path.join(os.homedir(), '.shelf', 'apps', appId, 'copilot');
}
