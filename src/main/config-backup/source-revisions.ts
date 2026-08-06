import crypto from 'crypto';

interface PinnedSource {
  remoteUrl: string;
  commit: string;
}

const MAX_PINNED_SOURCES = 256;
const pinned = new Map<string, PinnedSource>();

/** Register an opaque, process-local handle for a fetched source commit. */
export function pinImportSource(remoteUrl: string, commit: string): string {
  const token = crypto.randomUUID();
  pinned.set(token, { remoteUrl, commit });
  while (pinned.size > MAX_PINNED_SOURCES) {
    const oldest = pinned.keys().next().value;
    if (oldest === undefined) break;
    pinned.delete(oldest);
  }
  return token;
}

/** Resolve only when the caller supplies the same transient remote URL. */
export function resolveImportSource(remoteUrl: string, token: string): string | null {
  const source = pinned.get(token);
  return source?.remoteUrl === remoteUrl ? source.commit : null;
}

export function resetPinnedImportSourcesForTests(): void {
  pinned.clear();
}
