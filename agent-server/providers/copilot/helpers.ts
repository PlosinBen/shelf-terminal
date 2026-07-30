// Copilot specifics (pure / resolution only) — copilot SEMANTICS that differ from
// the shared acp/ toolkit live here, NOT in the toolkit (mirrors codex/helpers.ts).
// This is THE copilot binary resolver post-cutover (the pre-ACP native backend and
// its private resolveCopilotCliPath were deleted).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { COPILOT_PROVIDER } from '@shared/agent-providers';

/** Command + args to launch the `copilot` CLI in ACP mode over stdio. */
export interface CopilotCommand {
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
export function resolveCopilotCommand(
  findBinary: () => string | undefined = resolveCopilotBinary,
): CopilotCommand {
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
 * `COPILOT_HOME` for this app instance: `~/.shelf/apps/<appId>/copilot`. Both
 * `copilot --acp` and `copilot login` are pointed here so auth + skills are
 * ISOLATED per app instance (config-home isolation — see the copilot-acp feature
 * note). ACP's `NewSessionRequest` has no per-session skill field, so config-home
 * is the only channel for skill injection over ACP. Returns undefined with no app
 * context (falls back to the CLI's default ~/.copilot). Stable across version
 * updates (appId is per-install, not per-version).
 */
export function copilotConfigHome(appId: string | undefined): string | undefined {
  if (!appId) return undefined;
  return path.join(os.homedir(), '.shelf', 'apps', appId, COPILOT_PROVIDER);
}

/**
 * Spawn env for `copilot --acp` / `copilot login`: the base env plus
 * `COPILOT_HOME` when an app context exists. Shelf only hands the CLI a PATH; the
 * CLI owns the opaque credentials + config under it (the "don't parse auth"
 * principle). Returns `base` unchanged when there's no appId.
 */
export function copilotEnv(
  appId: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = copilotConfigHome(appId);
  return home ? { ...base, COPILOT_HOME: home } : base;
}
