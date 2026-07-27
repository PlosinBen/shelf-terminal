/**
 * Keep the complete renderer tab id in logs so every label remains exact and
 * grep-able. The distinguishing part of `tab-<epoch-ms>-<counter>` is at the
 * end, so prefix truncation makes concurrent tabs indistinguishable. See
 * agent-observability#3.
 */
export function formatTabLogId(tabId: string): string {
  return tabId;
}
