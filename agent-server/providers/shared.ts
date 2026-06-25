import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Strip a leading `cwd/` prefix from an absolute path so the renderer shows
 * project-relative paths. Shared verbatim by the Claude and Copilot providers
 * (tool-input formatters + file-edit card subtitles). No-op when cwd or path
 * is empty, or when the path isn't under cwd.
 */
export function stripCwd(p: string, cwd: string): string {
  if (!cwd || !p) return p;
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

/**
 * Resolve this app's projected skills plugin root on THIS machine —
 * `os.homedir()/.shelf/apps/<appId>/skills` — or null if `appId` is missing or
 * the dir hasn't been projected yet (no skills, or remote not yet synced). Both
 * ends self-resolve via `os.homedir()`, so the path is identical local/remote
 * with zero branching (see deployment#1 / feature §5.4). Providers point their
 * SDK at it: Claude `plugins[].path` = this root, Copilot `skillDirectories` =
 * `<root>/skills`.
 */
export function resolveSkillsPluginRoot(appId: string | undefined): string | null {
  if (!appId) return null;
  const root = path.join(os.homedir(), '.shelf', 'apps', appId, 'skills');
  try {
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}
