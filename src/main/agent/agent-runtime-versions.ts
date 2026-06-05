/**
 * Pinned runtime versions + download URL construction (R1, Phase 1.0).
 *
 * We bring our own Node so the remote's installed version (or absence) never
 * affects correctness — kills GOTCHAS #344 (esbuild target node20 vs old
 * remote node → SyntaxError). The Claude companion binary version is NOT pinned
 * here: it must match the `@anthropic-ai/claude-agent-sdk` JS bundled into
 * agent-server (the JS↔binary wire is a versioned pair), so it's resolved from
 * the app's installed SDK package at runtime via `claudeSdkVersion()`.
 *
 * Decision A (2026-06): fetch the Claude companion straight from the npm
 * registry tarball URL — no dependency on an `npm` CLI being present on the
 * user's machine (packaged apps often have none).
 *
 * Scope: glibc only (see runtime-target.ts header). Targets here are always
 * glibc — musl is rejected upstream at detectTargetFromProbe — so the URL
 * builders assume glibc; they throw defensively if handed a musl target.
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

/** Scoped npm package that ships the Claude CLI binary for a target. */
export function claudePackageName(t: RuntimeTarget): string {
  assertGlibc(t);
  return `@anthropic-ai/claude-agent-sdk-linux-${t.arch}`;
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

