import fs from 'fs';
import path from 'path';
import { app } from 'electron';

// TEMPORARY forensic log — bypasses logLevel so we always capture
// project-store reads/writes, regardless of user logLevel setting.
// Exists to diagnose "projects disappeared" style incidents.
//
// At v1.0.0 remove the bypass: delete this module and merge project-store
// events back into the regular `log.info` / `log.error` pattern so they
// respect the user's configured logLevel. Tracked in .agent/GOTCHAS.md.

function getAuditPath(): string {
  return path.join(app.getPath('userData'), 'project-audit.log');
}

export function appendAudit(event: string, details: Record<string, unknown> = {}): void {
  const payload = Object.keys(details).length > 0 ? ' ' + JSON.stringify(details) : '';
  const line = `${new Date().toISOString()} ${event}${payload}\n`;
  try {
    fs.appendFileSync(getAuditPath(), line);
  } catch {
    // swallow — audit must never break the app
  }
}

export function clearAudit(): void {
  const p = getAuditPath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // swallow
  }
}
