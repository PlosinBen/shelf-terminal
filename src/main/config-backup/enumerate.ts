import { listSkills } from '../skills-store';
import { listMcpServers } from '../mcp-store';
import { backupItemId, type BackupItemSummary } from '@shared/config-backup';

/**
 * Enumerate the machine's live, backup-able config items — the per-item
 * checklist the user ticks for Backup. Skills (each folder) + MCP servers (each
 * server). Nothing is read here beyond names/summaries; the actual file copy
 * happens in the Backup action.
 *
 * Ordering is stable (skills then MCP, each alphabetical) so the checklist is
 * deterministic across calls.
 */
export async function enumerateLiveItems(): Promise<BackupItemSummary[]> {
  const out: BackupItemSummary[] = [];

  const skills = await listSkills(); // already sorted by name
  for (const s of skills) {
    out.push({
      id: backupItemId('skill', s.name),
      kind: 'skill',
      name: s.name,
      ...(s.description ? { detail: s.description } : {}),
    });
  }

  const servers = listMcpServers(); // keyed object
  for (const name of Object.keys(servers).sort()) {
    out.push({
      id: backupItemId('mcp', name),
      kind: 'mcp',
      name,
      detail: servers[name].type,
    });
  }

  return out;
}
