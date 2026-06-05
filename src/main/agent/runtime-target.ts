/**
 * Remote runtime target detection (R1, Phase 1.0).
 *
 * "Bring our own runtime" means we ship a Node binary + the Claude CLI binary
 * to the remote. Those binaries are specific to BOTH cpu arch AND libc — a
 * glibc binary fails on Alpine (musl) with `no such file or directory` (the
 * dynamic loader is missing). So the deploy unit is `(arch × libc)`, not arch
 * alone. These pure parsers turn a remote probe into a validated target.
 *
 * Strategy by libc (2026-06):
 * - **glibc** → we ship our own Node (official nodejs.org), fully decoupled from
 *   the remote's node version.
 * - **musl** → we do NOT ship Node (no official musl Node exists; the community
 *   x64-only build isn't worth tying our supply chain to). Instead we use the
 *   remote's own node, gated by a minimum-version check (isRemoteNodeSupported).
 *   The Claude CLI binary is still ours (the `-musl` companion exists for both
 *   arches and is self-contained — verified on bare Alpine in the spike).
 *
 * Result: all four (arch × libc) combos are supported — the earlier arm64-musl
 * gap (no prebuilt musl Node) disappears because musl never ships our Node.
 */

export type Arch = 'x64' | 'arm64';
export type Libc = 'glibc' | 'musl';

export interface RuntimeTarget {
  arch: Arch;
  libc: Libc;
}

/** Stable id used for cache dir names and support checks, e.g. `x64-glibc`. */
export function targetId(t: RuntimeTarget): string {
  return `${t.arch}-${t.libc}`;
}

/** All four (arch × libc) combos are supported (see file header). */
export const SUPPORTED_TARGETS: readonly string[] = ['x64-glibc', 'arm64-glibc', 'x64-musl', 'arm64-musl'];

/** Minimum remote Node major for musl targets (we run agent-server on it). */
export const MIN_REMOTE_NODE_MAJOR = 20; // aligned with esbuild `target: node20`

/** Thrown when a remote's arch/libc cannot be determined or isn't supported. */
export class UnsupportedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedTargetError';
  }
}

/**
 * Single command run on the remote to probe arch + libc in one round-trip.
 * Line 1 = `uname -m`; the `ls` lines reveal the dynamic loader family.
 */
// `|| true` is required: on glibc systems the `ld-musl-*` glob matches nothing,
// so `ls` exits non-zero — without it, execSync treats the whole probe as a
// failure and deploy never starts. (Found via the docker E2E.)
export const TARGET_PROBE_CMD =
  'uname -m; ls /lib/ld-musl-* /lib/ld-linux-* /lib64/ld-linux-* /usr/lib/ld-linux-* 2>/dev/null || true';

export function parseArch(unameM: string): Arch {
  const m = unameM.trim().toLowerCase();
  if (m === 'aarch64' || m === 'arm64') return 'arm64';
  if (m === 'x86_64' || m === 'amd64' || m === 'x64') return 'x64';
  throw new UnsupportedTargetError(
    `Unsupported remote CPU architecture: "${unameM.trim()}". Only x64 and arm64 are supported.`,
  );
}

/**
 * Decide libc from the ld.so probe text. musl wins if any `ld-musl-*` is
 * present (some images carry both names, but ld-musl presence is definitive).
 */
export function parseLibc(probe: string): Libc {
  const s = probe.toLowerCase();
  if (s.includes('ld-musl')) return 'musl';
  if (s.includes('ld-linux')) return 'glibc';
  throw new UnsupportedTargetError(
    'Could not determine remote libc (no ld-musl-* or ld-linux-* dynamic loader found).',
  );
}

/**
 * Parse the combined `TARGET_PROBE_CMD` stdout into a validated, supported
 * target. Throws UnsupportedTargetError on unknown arch/libc or arm64-musl.
 */
export function detectTargetFromProbe(stdout: string): RuntimeTarget {
  const firstLine = stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const arch = parseArch(firstLine);
  const libc = parseLibc(stdout);
  const target: RuntimeTarget = { arch, libc };
  if (!SUPPORTED_TARGETS.includes(targetId(target))) {
    throw new UnsupportedTargetError(`${targetId(target)} is not a supported remote target.`);
  }
  return target;
}

/** Parse the major version from `node --version` output (`v20.18.1` → 20). */
export function parseNodeMajor(versionStr: string): number | null {
  const m = versionStr.trim().match(/v?(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Whether a remote's `node --version` meets our minimum (musl path, where we
 * run agent-server on the remote's own node). Too-old node would crash the
 * esbuild-node20 bundle with a cryptic SyntaxError (GOTCHAS #344).
 */
export function isRemoteNodeSupported(versionStr: string): boolean {
  const major = parseNodeMajor(versionStr);
  return major !== null && major >= MIN_REMOTE_NODE_MAJOR;
}
