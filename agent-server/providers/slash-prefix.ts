/**
 * Shared helper for providers that want to detect `/cmd args` at the start of
 * an incoming prompt. Each provider calls this from `query()` to decide
 * whether to dispatch internally to a slash handler or forward to the SDK.
 *
 * Multi-line prompts never match — a `/cmd` followed by a newline is treated
 * as regular text (e.g. quoted snippet that happens to start with a slash).
 *
 * Providers are free to bypass this helper and implement their own prefix
 * detection (e.g. add `\help` alongside `/help`, or skip detection entirely
 * and let the SDK natively interpret the prefix).
 */
export function parseSlashPrefix(prompt: string): { cmd: string; args: string } | null {
  if (prompt.includes('\n')) return null;
  const m = prompt.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { cmd: m[1], args: (m[2] ?? '').trim() };
}
