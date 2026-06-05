import { describe, it, expect } from 'vitest';
import { readTar, listTar, findFile } from './tar';

const BLOCK = 512;

interface HeaderOpts {
  name: string;
  mode?: number;
  type?: string; // typeflag char: '0' file, '5' dir, 'L' longlink
  prefix?: string;
}

/** Build a single 512-byte ustar header. Checksum omitted (reader ignores it). */
function header({ name, mode = 0o644, type = '0', prefix = '' }: HeaderOpts, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0);
  h.write(mode.toString(8).padStart(7, '0'), 100);
  h.write(size.toString(8).padStart(11, '0'), 124);
  h.write(type, 156);
  h.write('ustar', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345);
  return h;
}

/** Pad a buffer up to the next 512 boundary. */
function pad(buf: Buffer): Buffer {
  const rem = buf.length % BLOCK;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]);
}

/** Build a tar entry (header + padded data) for a file/dir. */
function entry(opts: HeaderOpts, content = ''): Buffer {
  const data = Buffer.from(content);
  return Buffer.concat([header(opts, data.length), pad(data)]);
}

/** GNU long-link pseudo-entry carrying the next entry's long name. */
function longLink(longName: string): Buffer {
  const data = Buffer.from(longName + '\0');
  return Buffer.concat([header({ name: '././@LongLink', type: 'L' }, data.length), pad(data)]);
}

const endBlocks = Buffer.alloc(BLOCK * 2);

describe('readTar', () => {
  it('reads a regular file with content and mode', () => {
    const tar = Buffer.concat([entry({ name: 'a/b.txt', mode: 0o644 }, 'hello'), endBlocks]);
    const entries = listTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'a/b.txt', type: 'file', mode: 0o644, size: 5 });
    expect(entries[0].data.toString()).toBe('hello');
  });

  it('preserves the executable bit (node/claude need it)', () => {
    const tar = Buffer.concat([entry({ name: 'bin/node', mode: 0o755 }, 'BIN'), endBlocks]);
    expect(listTar(tar)[0].mode).toBe(0o755);
  });

  it('classifies directories (typeflag 5) and gives empty data', () => {
    const tar = Buffer.concat([entry({ name: 'dir/', type: '5' }), endBlocks]);
    const e = listTar(tar)[0];
    expect(e.type).toBe('directory');
    expect(e.data).toHaveLength(0);
  });

  it('joins ustar prefix + name into the full path', () => {
    const tar = Buffer.concat([
      entry({ name: 'file.bin', prefix: 'long/prefix/path' }, 'x'),
      endBlocks,
    ]);
    expect(listTar(tar)[0].name).toBe('long/prefix/path/file.bin');
  });

  it('resolves GNU long-link names for the following entry', () => {
    const longName = 'node-v20.18.1-linux-x64/' + 'deep/'.repeat(20) + 'bin/node';
    const tar = Buffer.concat([
      longLink(longName),
      entry({ name: 'truncated-name', mode: 0o755 }, 'BIN'),
      endBlocks,
    ]);
    const entries = listTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(longName);
    expect(entries[0].mode).toBe(0o755);
    expect(entries[0].data.toString()).toBe('BIN');
  });

  it('reads multiple entries and stops at the zero-block terminator', () => {
    const tar = Buffer.concat([
      entry({ name: 'one' }, 'AAA'),
      entry({ name: 'two' }, 'BBBB'),
      endBlocks,
      entry({ name: 'after-end-should-be-ignored' }, 'ZZZ'),
    ]);
    const names = listTar(tar).map((e) => e.name);
    expect(names).toEqual(['one', 'two']);
  });
});

describe('findFile', () => {
  const tar = Buffer.concat([
    entry({ name: 'package/other.js' }, '//'),
    entry({ name: 'package/claude', mode: 0o755 }, 'CLAUDE'),
    endBlocks,
  ]);

  it('finds by exact path', () => {
    expect(findFile(tar, 'package/claude')?.data.toString()).toBe('CLAUDE');
  });
  it('finds by predicate', () => {
    expect(findFile(tar, (n) => n.endsWith('/claude'))?.mode).toBe(0o755);
  });
  it('returns undefined when absent', () => {
    expect(findFile(tar, 'nope')).toBeUndefined();
  });
});
