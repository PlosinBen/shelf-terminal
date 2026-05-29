import { describe, it, expect } from 'vitest';
import { parseDataTransfer } from './parse-data-transfer';

// Vitest runs in Node (no DOM). `File` is globally available on Node 20+, but
// `DataTransfer` / `DataTransferItem` are not — so we build a minimal fake
// that exposes just what the parser reads (`getData` + `items[].kind` +
// `items[].getAsFile`). This mirrors the real browser surface 1:1 for the
// fields we touch, without dragging in jsdom/happy-dom.

interface FakeItem {
  kind: 'file' | 'string';
  type: string;
  getAsFile: () => File | null;
}

function makeDataTransfer(opts: { text?: string; files?: File[] }): DataTransfer {
  const items: FakeItem[] = [];
  if (opts.files) {
    for (const f of opts.files) {
      items.push({ kind: 'file', type: f.type, getAsFile: () => f });
    }
  }
  return {
    getData: (format: string) => (format === 'text/plain' ? opts.text ?? '' : ''),
    items: items as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

function makeFile(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe('parseDataTransfer', () => {
  it('returns [] for null input', () => {
    expect(parseDataTransfer(null)).toEqual([]);
  });

  it('returns [] for empty DataTransfer', () => {
    expect(parseDataTransfer(makeDataTransfer({}))).toEqual([]);
  });

  it('extracts plain text', () => {
    const result = parseDataTransfer(makeDataTransfer({ text: 'hello world' }));
    expect(result).toEqual([{ kind: 'text', text: 'hello world', isImage: false }]);
  });

  it('preserves \\r\\n in plain text', () => {
    const result = parseDataTransfer(makeDataTransfer({ text: 'line1\r\nline2' }));
    expect(result).toEqual([{ kind: 'text', text: 'line1\r\nline2', isImage: false }]);
  });

  it('text items carry isImage: false (so consumers can filter on isImage uniformly)', () => {
    const [item] = parseDataTransfer(makeDataTransfer({ text: 'hi' }));
    expect(item.isImage).toBe(false);
    expect(item.kind).toBe('text');
  });

  it('skips empty text (does not push text item)', () => {
    const result = parseDataTransfer(makeDataTransfer({ text: '' }));
    expect(result).toEqual([]);
  });

  it('extracts a single PNG image with isImage=true and ext=png', () => {
    const file = makeFile('image.png', 'image/png');
    const result = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'file', ext: 'png', isImage: true });
    expect((result[0] as { file: File }).file).toBe(file);
  });

  it('JPEG: ext=jpeg', () => {
    const file = makeFile('photo.jpg', 'image/jpeg');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ kind: 'file', ext: 'jpeg', isImage: true });
  });

  it('WEBP: ext=webp', () => {
    const file = makeFile('animation.webp', 'image/webp');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ kind: 'file', ext: 'webp', isImage: true });
  });

  it('SVG (image/svg+xml): isImage=true, ext=svg (strips +xml)', () => {
    const file = makeFile('icon.svg', 'image/svg+xml');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ kind: 'file', ext: 'svg', isImage: true });
  });

  it('HEIC: isImage=true, ext=heic (MIME prefix is the rule)', () => {
    const file = makeFile('IMG.heic', 'image/heic');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ kind: 'file', ext: 'heic', isImage: true });
  });

  it('non-image file: isImage=false, ext from filename', () => {
    const file = makeFile('report.pdf', 'application/pdf');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ kind: 'file', ext: 'pdf', isImage: false });
  });

  it('unknown MIME + no extension in filename → ext=bin', () => {
    const file = makeFile('Makefile', '');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ kind: 'file', ext: 'bin', isImage: false });
  });

  it('multiple images preserve order', () => {
    const a = makeFile('a.png', 'image/png');
    const b = makeFile('b.jpg', 'image/jpeg');
    const c = makeFile('c.webp', 'image/webp');
    const result = parseDataTransfer(makeDataTransfer({ files: [a, b, c] }));
    expect(result.map((i) => (i.kind === 'file' ? i.ext : null))).toEqual(['png', 'jpeg', 'webp']);
  });

  it('text + image together both surface', () => {
    const file = makeFile('shot.png', 'image/png');
    const result = parseDataTransfer(makeDataTransfer({ text: 'caption', files: [file] }));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: 'text', text: 'caption', isImage: false });
    expect(result[1]).toMatchObject({ kind: 'file', isImage: true });
  });

  it('mixed image + non-image file: both surface with correct flags', () => {
    const img = makeFile('shot.png', 'image/png');
    const pdf = makeFile('doc.pdf', 'application/pdf');
    const result = parseDataTransfer(makeDataTransfer({ files: [img, pdf] }));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ ext: 'png', isImage: true });
    expect(result[1]).toMatchObject({ ext: 'pdf', isImage: false });
  });

  it('item with kind=file but getAsFile() returns null is skipped', () => {
    const items: FakeItem[] = [{ kind: 'file', type: 'image/png', getAsFile: () => null }];
    const data = {
      getData: () => '',
      items: items as unknown as DataTransferItemList,
    } as unknown as DataTransfer;
    expect(parseDataTransfer(data)).toEqual([]);
  });

  it('does not double-count when .files mirrors .items (parser reads items only)', () => {
    // Real browsers expose the same file in both .items[i].getAsFile() and
    // .files[i]. The parser reads .items exclusively, so even if a caller
    // wired both up the result has one entry per file. Our fake omits .files
    // entirely — this test pins down the contract that the implementation
    // never consults .files.
    const file = makeFile('once.png', 'image/png');
    const result = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(result).toHaveLength(1);
  });

  it('filename starting with dot (.gitignore) is treated as having no extension', () => {
    const file = makeFile('.gitignore', 'text/plain');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ ext: 'bin', isImage: false });
  });

  it('uppercase filename extension is lowercased', () => {
    const file = makeFile('REPORT.PDF', 'application/pdf');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ ext: 'pdf', isImage: false });
  });

  it('multi-dot extension grabs the last segment', () => {
    // archive.tar.gz → 'gz' (consumer that cares about compound exts has to
    // inspect file.name itself; parser keeps it simple).
    const file = makeFile('archive.tar.gz', 'application/gzip');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ ext: 'gz', isImage: false });
  });

  it('clipboard with only text/html (no text/plain) does not surface a text item', () => {
    // Some sources (Slack, browsers) put rich HTML on the clipboard without
    // a text/plain twin. Parser only reads text/plain — anything else falls
    // through to the browser's default handler.
    const data = {
      getData: (format: string) => (format === 'text/html' ? '<b>rich</b>' : ''),
      items: [] as unknown as DataTransferItemList,
    } as unknown as DataTransfer;
    expect(parseDataTransfer(data)).toEqual([]);
  });

  it('file with empty MIME is NOT treated as image (rule is strict prefix)', () => {
    // Rare but real: some sources (older Electron / clipboard quirks) hand
    // over a file with file.type === ''. Without a positive image/* signal,
    // the parser refuses to guess — caller can still inspect the filename
    // and decide.
    const file = makeFile('mystery.png', '');
    const [item] = parseDataTransfer(makeDataTransfer({ files: [file] }));
    expect(item).toMatchObject({ isImage: false, ext: 'png' }); // ext still from filename
  });
});

