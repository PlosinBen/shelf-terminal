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
