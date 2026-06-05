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

/**
 * Resolve the Claude SDK version actually bundled into the app, so the
 * companion binary we ship matches it. Reader is injected for testability;
 * the wiring layer passes a fn that reads the installed package.json.
 */
export function claudeSdkVersion(readPackageVersion: (pkgName: string) => string): string {
  const v = readPackageVersion('@anthropic-ai/claude-agent-sdk');
  if (!v) throw new Error('Could not resolve @anthropic-ai/claude-agent-sdk version from app packages.');
  return v;
}
