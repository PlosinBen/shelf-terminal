/**
 * Pure parser for `DataTransfer` — works for both clipboard paste
 * (`e.clipboardData`) and drag-drop (`e.dataTransfer`) since both expose the
 * same `DataTransfer` interface.
 *
 * Design rules (see `.agent/features/parse-data-transfer.md`):
 * - Synchronous, no side effects.
 * - Does NOT call `preventDefault()` — caller decides based on result.
 * - Does NOT read file contents (`arrayBuffer` / `readAsDataURL`) — caller
 *   awaits these on the `File` object only when actually needed.
 * - Returns Web API `File` objects directly. Both screenshot pastes
 *   (synthetic in-memory File) and on-disk drag-drops yield `File`, so
 *   consumers handle them uniformly.
 * - Only two `kind`s — `'text'` and `'file'`. "Image" is just a File with
 *   MIME `image/*`, surfaced via the `isImage` flag rather than its own
 *   variant. Keeps the API stable when video / audio attachments appear,
 *   and centralizes the "is it an image" rule in one place.
 */

export type PastedItem =
  | { kind: 'text'; text: string; isImage: false }
  | { kind: 'file'; file: File; ext: string; isImage: boolean };

export function parseDataTransfer(data: DataTransfer | null): PastedItem[] {
  if (!data) return [];

  const result: PastedItem[] = [];

  // Text — read once via getData('text/plain'). DataTransferItemList also
  // exposes text items but they require an async callback API; getData is
  // synchronous and is the conventional source for plain text.
  const text = data.getData('text/plain');
  if (text) {
    result.push({ kind: 'text', text, isImage: false });
  }

  // Files — iterate `.items` (the superset; `.files` is a derived subset of
  // kind='file' entries, so reading both would double-count).
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    if (item.kind !== 'file') continue;

    const file = item.getAsFile();
    if (!file) continue;

    const isImage = file.type.startsWith('image/');
    const ext = deriveExt(file, isImage);

    result.push({ kind: 'file', file, ext, isImage });
  }

  return result;
}

/**
 * Image: derive from MIME (`image/png` → `png`). `image/svg+xml` strips the
 * `+xml` suffix → `svg`. Empty MIME is impossible for the image branch
 * because that would also defeat `isImage`.
 *
 * Non-image: fall back to the file's name extension. If neither yields
 * anything, `'bin'` so the caller never has to deal with an empty string.
 */
function deriveExt(file: File, isImage: boolean): string {
  if (isImage) {
    const afterSlash = file.type.slice('image/'.length); // 'png' / 'svg+xml'
    const clean = afterSlash.split('+')[0].trim();
    if (clean) return clean.toLowerCase();
  }

  const name = file.name || '';
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < name.length - 1) {
    return name.slice(dotIdx + 1).toLowerCase();
  }

  return 'bin';
}
