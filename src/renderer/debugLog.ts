/**
 * Fire-and-forget renderer→main diagnostic log. Persists to the main log file
 * (`<userData>/logs/<YYYYMM>/<MMDD>.log`) when the app's log level is info/debug
 * — so renderer-only UI flows that are invisible from outside the renderer can
 * be traced from disk. No-op when the bridge isn't present (e.g. unit tests).
 */
export function debugLog(tag: string, msg: string): void {
  try {
    window.shelfApi.app.debugLog(tag, msg);
  } catch {
    /* bridge absent */
  }
}
