/**
 * Normalize the optional project-level feature-note directory.
 *
 * The persisted value is a repo-relative POSIX directory. An absent or blank
 * value disables feature-note handoff; unsafe or non-canonical relative paths
 * are rejected instead of being silently rewritten.
 */
export function normalizeFeatureNoteDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('/')) {
    throw new Error('Feature note directory must be relative to the project root');
  }
  if (trimmed.includes('\\')) {
    throw new Error('Feature note directory must use POSIX path separators');
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('Feature note directory must not be the project root');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error('Feature note directory must not contain empty path segments');
  }
  if (segments.some((segment) => segment === '.')) {
    throw new Error('Feature note directory must not contain current-directory segments');
  }
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Feature note directory must not traverse parent directories');
  }

  return normalized;
}
