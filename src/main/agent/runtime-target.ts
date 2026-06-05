/**
 * Remote runtime target detection (R1, Phase 1.0).
 *
 * "Bring our own runtime" means we ship a Node binary + the Claude CLI binary
 * to the remote. Those binaries are specific to BOTH cpu arch AND libc — a
 * glibc binary fails on Alpine (musl) with `no such file or directory` (the
 * dynamic loader is missing). So the deploy unit is `(arch × libc)`, not arch
 * alone. These pure parsers turn a remote probe into a validated target.
 *
 * Scope decision (2026-06): **glibc only.** Node.js publishes NO official musl
 * build for any arch — musl Node exists solely on the community
 * `unofficial-builds.nodejs.org` (and only for x64, never arm64). Rather than
 * tie our supply chain to an unofficial source, we mirror Node's own support
 * matrix: if upstream doesn't officially support musl, neither do we. All musl
 * remotes (every Alpine, any arch) are refused with a clear error — we never
 * silently fall back to the remote's node (that would reintroduce the version
 * drift this whole feature exists to kill).
 *
 * Verified by spike (2026-06): glibc distros (debian/ubuntu) interchange; glibc
 * binaries fail on musl with `no such file or directory` (missing loader).
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

/**
 * Targets we support — glibc only, matching Node's official release matrix.
 * musl is excluded entirely (see file header): no official musl Node exists.
 */
export const SUPPORTED_TARGETS: readonly string[] = ['x64-glibc', 'arm64-glibc'];

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
export const TARGET_PROBE_CMD =
  'uname -m; ls /lib/ld-musl-* /lib/ld-linux-* /lib64/ld-linux-* /usr/lib/ld-linux-* 2>/dev/null';

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
  if (libc === 'musl') {
    throw new UnsupportedTargetError(
      'musl-based remotes (e.g. Alpine) are not supported: Node.js publishes no official musl build. ' +
        'Use a glibc distro (Debian, Ubuntu, Fedora, etc.).',
    );
  }
  const target: RuntimeTarget = { arch, libc };
  if (!SUPPORTED_TARGETS.includes(targetId(target))) {
    throw new UnsupportedTargetError(`${targetId(target)} is not a supported remote target.`);
  }
  return target;
}
