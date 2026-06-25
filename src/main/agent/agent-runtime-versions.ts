/**
 * Pinned runtime versions + download URL construction (R1, Phase 1.0).
 *
 * We bring our own Node so the remote's installed version (or absence) never
 * affects correctness — kills build-packaging#6 (esbuild target node20 vs old
 * remote node → SyntaxError). The Claude companion binary version is NOT pinned
 * here: it must match the `@anthropic-ai/claude-agent-sdk` JS bundled into
 * agent-server (the JS↔binary wire is a versioned pair), so it's resolved from
 * the app's installed SDK package at runtime via `claudeSdkVersion()`.
 *
 * Decision A (2026-06): fetch the Claude companion straight from the npm
 * registry tarball URL — no dependency on an `npm` CLI being present on the
 * user's machine (packaged apps often have none).
 *
 * Node builders are glibc-only (we never ship our own musl Node — see
 * runtime-target.ts header) and throw on a musl target. Claude builders handle
 * all four combos (an official `-musl` companion exists for both arches).
 */

import { type RuntimeTarget, targetId, UnsupportedTargetError } from './runtime-target';

/** Aligned with esbuild `target: node20` and validated by the R1 spike. */
export const NODE_VERSION = 'v20.18.1';

/**
 * Claude CLI companion version to download — MUST match the
 * `@anthropic-ai/claude-agent-sdk` JS bundled into agent-server (JS↔binary is a
 * versioned wire pair). The SDK package's `exports` map blocks importing its
 * package.json, so we pin it here; a unit test asserts it equals the installed
 * dependency's version, so bumping the dep without updating this fails loudly.
 */
export const CLAUDE_SDK_VERSION = '0.3.159';

function assertGlibc(t: RuntimeTarget): void {
  if (t.libc !== 'glibc') {
    throw new UnsupportedTargetError(`${targetId(t)} is unsupported here: only glibc targets are built.`);
  }
}

/** Directory name inside the Node tarball (and our cache), e.g. `node-v20.18.1-linux-x64`. */
export function nodeArchiveName(t: RuntimeTarget, version: string = NODE_VERSION): string {
  assertGlibc(t);
  return `node-${version}-linux-${t.arch}`;
}

/** Official nodejs.org download URL for the glibc Node tarball. */
export function nodeDownloadUrl(t: RuntimeTarget, version: string = NODE_VERSION): string {
  return `https://nodejs.org/dist/${version}/${nodeArchiveName(t, version)}.tar.gz`;
}

/** nodejs.org SHASUMS256.txt for integrity verification of the Node tarball. */
export function nodeShasumsUrl(version: string = NODE_VERSION): string {
  return `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
}

/** npm version manifest URL — carries `dist.integrity` (SRI) for the Claude tgz. */
export function claudeManifestUrl(t: RuntimeTarget, version: string): string {
  return `https://registry.npmjs.org/${claudePackageName(t)}/${version}`;
}

/**
 * Scoped npm package that ships the Claude CLI binary for a target. Unlike Node,
 * Claude has an official `-musl` companion for both arches, so this handles all
 * four (arch × libc) combos.
 */
export function claudePackageName(t: RuntimeTarget): string {
  const suffix = t.libc === 'musl' ? '-musl' : '';
  return `@anthropic-ai/claude-agent-sdk-linux-${t.arch}${suffix}`;
}

/**
 * Direct npm registry tarball URL for the Claude companion (Decision A).
 * Scoped format: `https://registry.npmjs.org/<scope>/<name>/-/<name>-<ver>.tgz`
 * where the path keeps the scope but the filename is unscoped.
 */
export function claudeTarballUrl(t: RuntimeTarget, version: string): string {
  const pkg = claudePackageName(t);
  const unscoped = pkg.split('/')[1];
  return `https://registry.npmjs.org/${pkg}/-/${unscoped}-${version}.tgz`;
}

/**
 * Copilot CLI companion version — MUST match the `@github/copilot` JS the
 * copilot-sdk drives. Pinned (same reasoning as CLAUDE_SDK_VERSION); a unit
 * test asserts it equals the installed dependency.
 */
export const COPILOT_CLI_VERSION = '1.0.56';

/**
 * Scoped npm package shipping the standalone Copilot CLI binary for a target.
 * The variant is a PREFIX (`linux` / `linuxmusl`) — different shape from
 * Claude's `-musl` suffix. All four (arch × libc) combos exist.
 */
export function copilotPackageName(t: RuntimeTarget): string {
  const variant = t.libc === 'musl' ? 'linuxmusl' : 'linux';
  return `@github/copilot-${variant}-${t.arch}`;
}

/** Direct npm registry tarball URL for the Copilot companion. */
export function copilotTarballUrl(t: RuntimeTarget, version: string): string {
  const pkg = copilotPackageName(t);
  const unscoped = pkg.split('/')[1];
  return `https://registry.npmjs.org/${pkg}/-/${unscoped}-${version}.tgz`;
}

/** npm version manifest URL — carries `dist.integrity` (SRI) for the Copilot tgz. */
export function copilotManifestUrl(t: RuntimeTarget, version: string): string {
  return `https://registry.npmjs.org/${copilotPackageName(t)}/${version}`;
}

