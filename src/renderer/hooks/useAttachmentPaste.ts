import { useEffect, useRef, type RefObject } from 'react';
import type { Connection } from '@shared/types';

export interface AttachmentUpload {
  file: File;
  /** Absolute remote path where the file was written. */
  remotePath: string;
  /** Path relative to cwd when the upload lives under it, otherwise absolute. */
  displayPath: string;
}

export interface UseAttachmentPasteOpts {
  connection: Connection;
  cwd: string;
  maxUploadSizeMB?: number;
  /** Called with successfully uploaded non-image files (or all files if onImages
   * is not provided). Callers should display a badge / write the path somewhere. */
  onUpload: (uploads: AttachmentUpload[]) => void;
  /** Optional — if provided, image files are read as data URLs and passed here
   * instead of uploaded. Useful for multimodal chat inputs that want the raw
   * base64 payload. */
  onImages?: (dataUrls: string[]) => void;
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(files: File[], opts: UseAttachmentPasteOpts): Promise<AttachmentUpload[]> {
  const limitMB = opts.maxUploadSizeMB ?? 50;
  const maxBytes = limitMB * 1024 * 1024;

  const accepted: File[] = [];
  const oversized: File[] = [];
  for (const f of files) {
    if (f.size > maxBytes) oversized.push(f);
    else accepted.push(f);
  }

  if (oversized.length > 0) {
    const list = oversized
      .map((f) => `• ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`)
      .join('\n');
    void window.shelfApi.dialog.warn(
      'File too large',
      `The following file(s) exceed the ${limitMB} MB upload limit and were skipped:\n\n${list}\n\nYou can change the limit in Settings.`,
    );
  }

  if (accepted.length === 0) return [];

  const results = await Promise.all(
    accepted.map(async (f) => {
      try {
        const buffer = await f.arrayBuffer();
        const result = await window.shelfApi.connector.uploadFile(opts.connection, opts.cwd, f.name, buffer);
        return { file: f, result };
      } catch (err: any) {
        return { file: f, result: { ok: false as const, reason: err?.message ?? String(err) } };
      }
    }),
  );

  const uploads: AttachmentUpload[] = [];
  const failures: { name: string; reason: string }[] = [];
  const cwdPrefix = opts.cwd.replace(/\/+$/, '') + '/';
  for (const { file, result } of results) {
    if (result.ok) {
      const displayPath = result.remotePath.startsWith(cwdPrefix)
        ? result.remotePath.slice(cwdPrefix.length)
        : result.remotePath;
      uploads.push({ file, remotePath: result.remotePath, displayPath });
    } else {
      failures.push({ name: file.name, reason: result.reason });
    }
  }

  if (failures.length > 0) {
    const list = failures.map((f) => `• ${f.name}: ${f.reason}`).join('\n');
    void window.shelfApi.dialog.warn('Upload failed', list);
  }

  return uploads;
}

/**
 * Binds paste + drop handlers on the ref'd element. Paste ignores the browser's
 * rich-text copy (text/html) so xterm-style text paste still works; only file
 * attachments are intercepted.
 */
export function useAttachmentPaste(
  ref: RefObject<HTMLElement | null>,
  opts: UseAttachmentPasteOpts,
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    async function routeFiles(files: File[]) {
      const current = optsRef.current;
      const extractImages = !!current.onImages;
      const toUpload: File[] = [];
      const imageDataUrls: string[] = [];

      for (const f of files) {
        if (extractImages && f.type.startsWith('image/')) {
          const url = await readFileAsDataUrl(f);
          if (url) imageDataUrls.push(url);
        } else {
          toUpload.push(f);
        }
      }

      if (imageDataUrls.length > 0) current.onImages?.(imageDataUrls);
      if (toUpload.length > 0) {
        const uploads = await uploadFiles(toUpload, current);
        if (uploads.length > 0) current.onUpload(uploads);
      }
    }

    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const itemArr = Array.from(items);
      // text/html means rich-text paste (e.g. from a browser) — let the native
      // handler do its thing.
      if (itemArr.some((it) => it.type === 'text/html')) return;

      const files: File[] = [];
      for (const item of itemArr) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      await routeFiles(files);
    };

    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleDrop = async (e: DragEvent) => {
      const list = e.dataTransfer?.files;
      if (!list || list.length === 0) return;
      e.preventDefault();
      await routeFiles(Array.from(list));
    };

    el.addEventListener('paste', handlePaste, true);
    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('drop', handleDrop);
    return () => {
      el.removeEventListener('paste', handlePaste, true);
      el.removeEventListener('dragover', handleDragOver);
      el.removeEventListener('drop', handleDrop);
    };
  }, [ref]);
}
