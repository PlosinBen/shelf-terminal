/**
 * Render a byte count as the largest unit that yields a value ≥ 1, using
 * binary prefixes (1 KB = 1024 B). One decimal place for KB / MB to keep
 * the number readable without misleading precision; two decimals for GB
 * since values there tend to be flatter (1.20 GB vs 1.2 GB is more useful).
 *
 * Negative and non-finite inputs are clamped to `0 B` so callers don't have
 * to special-case them — the UI elsewhere uses `0 B` to mean both "no files
 * yet" and "just cleared", so the same fallback fits NaN / -∞ inputs.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
