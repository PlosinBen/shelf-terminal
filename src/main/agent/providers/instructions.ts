import type { Connection } from '@shared/types';
import { createConnector } from '../../connector';
import { log } from '@shared/logger';

/**
 * Load project instruction file (AGENTS.md preferred, CLAUDE.md fallback) from
 * the git repo root. Monorepos are expected to keep a single AGENTS.md at the
 * repo root that indexes into nested READMEs — we deliberately do not walk
 * further down or up. If cwd isn't inside a git repo we fall back to reading
 * from cwd directly.
 *
 * Runs through connector.exec so local / SSH / Docker / WSL all work. No
 * caching: re-reads every query so file edits / branch switches apply
 * immediately. Token cost is amortised by provider-side prompt caching.
 */
export async function loadProjectInstructions(cwd: string, connection: Connection): Promise<string | null> {
  const connector = createConnector(connection);
  const script = [
    'root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || echo "$1")',
    'for f in AGENTS.md CLAUDE.md; do',
    '  if [ -r "$root/$f" ]; then cat "$root/$f"; exit 0; fi',
    'done',
    'exit 0',
  ].join('\n');
  const cmd = `sh -c ${shellSingleQuote(script)} -- ${shellSingleQuote(cwd)}`;

  try {
    const { stdout } = await connector.exec(cwd, cmd);
    return stdout.trim().length > 0 ? stdout : null;
  } catch (err: any) {
    log.info('instructions', `Failed to load project instructions: ${err?.message}`);
    return null;
  }
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
