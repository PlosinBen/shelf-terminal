/**
 * Minimal pure-JS tar reader (R1, Phase 1.1).
 *
 * We download Node + the Claude CLI as `.tar.gz` / `.tgz` and need to pull a
 * couple of specific files out (`node-.../bin/node`, `package/claude`). Node has
 * built-in gzip (`zlib`) but NO tar support. Rather than shell out to the system
 * `tar` (absent/inconsistent across host OSes — the host may be Windows), we
 * parse the archive ourselves. Pure JS ⇒ identical behavior on every host, zero
 * environment branching, zero new runtime dependency.
 *
 * Scope: handles the standard `ustar` format these archives use — regular files,
 * directories, ustar `prefix` (split long paths), and GNU `L` long-link entries.
 * Octal numeric fields only (node/npm tarballs never need base-256). Checksums
 * are not verified — integrity is covered by a SHA check on the whole download.
 *
 * This module is pure (Buffer in → entries out); gunzip + fs writing live in the
 * caller (runtime-cache) so this stays trivially unit-testable.
 */

const BLOCK = 512;

export type TarEntryType = 'file' | 'directory' | 'other';

export interface TarEntry {
  /** Full path (ustar prefix + name, or GNU long name). */
  name: string;
  type: TarEntryType;
  /** Permission bits (mode & 0o7777) — we care about the exec bit. */
  mode: number;
  size: number;
  /** File contents (empty Buffer for non-files). */
  data: Buffer;
}

function isZeroBlock(buf: Buffer, off: number): boolean {
  for (let i = 0; i < BLOCK; i++) {
    if (buf[off + i] !== 0) return false;
  }
  return true;
}

/** Read a NUL-terminated string field. */
function str(buf: Buffer, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul === -1 ? len : nul);
}

/** Parse an octal numeric field (space/NUL padded). */
function octal(buf: Buffer, off: number, len: number): number {
  const s = str(buf, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isNaN(n) ? 0 : n;
}

function typeOf(flag: string): TarEntryType {
  if (flag === '0' || flag === '\0' || flag === '') return 'file';
  if (flag === '5') return 'directory';
  return 'other';
}

/**
 * Iterate the entries of an (uncompressed) tar buffer. Caller gunzips first.
 */
export function* readTar(buf: Buffer): Generator<TarEntry> {
  let off = 0;
  let longName: string | null = null;

  while (off + BLOCK <= buf.length) {
    if (isZeroBlock(buf, off)) break; // end-of-archive marker

    const name = str(buf, off, 100);
    const mode = octal(buf, off + 100, 8) & 0o7777;
    const size = octal(buf, off + 124, 12);
    const flag = String.fromCharCode(buf[off + 156]);
    const prefix = str(buf, off + 345, 155);

    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    const data = buf.subarray(dataStart, dataEnd);

    // Advance past header + data (data padded to a 512 boundary).
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === 'L') {
      // GNU long name: this entry's data is the name of the NEXT real entry.
      longName = str(data, 0, data.length);
      continue;
    }
    if (flag === 'x' || flag === 'g') {
      // pax extended headers — not needed for node/npm tarballs; skip.
      continue;
    }

    const fullName = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;

    const type = typeOf(flag);
    yield {
      name: fullName,
      type,
      mode,
      size,
      data: type === 'file' ? data : Buffer.alloc(0),
    };
  }
}

/** Collect all entries into an array. */
export function listTar(buf: Buffer): TarEntry[] {
  return [...readTar(buf)];
}

/**
 * Find the first file entry whose path matches. `match` may be an exact full
 * path or a predicate. Returns undefined if not found.
 */
export function findFile(
  buf: Buffer,
  match: string | ((name: string) => boolean),
): TarEntry | undefined {
  const pred = typeof match === 'string' ? (n: string) => n === match : match;
  for (const e of readTar(buf)) {
    if (e.type === 'file' && pred(e.name)) return e;
  }
  return undefined;
}
