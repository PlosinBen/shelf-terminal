import * as scrollback from './scrollback-buffer';

const REDLINE_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+).*\//,   // rm -rf / rm -f with path
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+.*\//,                  // rm -r with path
  /git\s+push\s+(-[a-zA-Z]*f|--force)/,                 // git push --force
  /DROP\s+TABLE/i,
  /TRUNCATE\s+/i,
  /chmod\s+777/,
  /mkfs\./,                                              // format filesystem
  />\s*\/dev\/sd[a-z]/,                                  // write to block device
  /dd\s+.*of=\/dev\//,                                   // dd to device
];

export interface RedlineResult {
  blocked: boolean;
  pattern?: string;
  snippet?: string;
}

export function checkRedline(tabId: string): RedlineResult {
  const recent = scrollback.read(tabId, 10);
  for (const re of REDLINE_PATTERNS) {
    const match = recent.match(re);
    if (match) {
      return {
        blocked: true,
        pattern: match[0],
        snippet: recent.split('\n').slice(-5).join('\n'),
      };
    }
  }
  return { blocked: false };
}
