/**
 * Telegram bridge mode-switching helpers.
 *
 * Pure (no Telegram API side-effects). Tests can exercise alias derivation
 * and resolve logic without mocking the Telegram polling loop. See
 * features/telegram-agent-bridge.md.
 */
import { isAgentTab, getAgentProvider } from '../agent';
import { getSyncedProjects } from './tools';

/**
 * Derive a Telegram-friendly alias from project name. Telegram command names
 * must match `^[a-z][a-z0-9_]{0,31}$`, so:
 *   - strip all non-ASCII-alphanumeric (whitespace, dash, dot, CJK, emoji…)
 *   - lower case
 *   - truncate to leave room for `use_` prefix (4 chars → 28 chars budget)
 *
 * Pure-non-ASCII project name (e.g. all CJK) reduces to empty string —
 * caller should fall back to project id prefix. See `aliasOrFallback`.
 */
export function deriveAlias(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 28);
}

/**
 * Alias with id-prefix fallback for projects whose name strips to empty
 * (pure CJK, emoji, etc.). Id is a UUID; we take the first 6 alphanumeric
 * chars (drop the dashes).
 */
export function aliasOrFallback(name: string, id: string): string {
  const derived = deriveAlias(name);
  if (derived) return derived;
  return id.replace(/-/g, '').slice(0, 6).toLowerCase();
}

export type AliasResolveResult =
  | { ok: true; tabId: string; projectName: string; provider: string }
  | { ok: false; reason: 'not_found' | 'no_agent' | 'multiple_agents' };

/**
 * Resolve a `/use_<alias>` slash command argument to the underlying agent
 * tab. Returns:
 *   - { ok: true, ... } when exactly one agent tab exists in the matched
 *     project — caller switches mode to that tab.
 *   - { ok: false, reason: 'not_found' } when no project matches the alias.
 *   - { ok: false, reason: 'no_agent' } when the project exists but has no
 *     active agent session — user must open one in Shelf first.
 *   - { ok: false, reason: 'multiple_agents' } when the project has 2+
 *     agent tabs (Claude + Copilot etc.) — MVP doesn't disambiguate,
 *     user must pick from Shelf UI.
 *
 * Case-insensitive match against the derived/fallback alias.
 */
export function resolveAlias(aliasArg: string): AliasResolveResult {
  const target = aliasArg.toLowerCase();
  const projects = getSyncedProjects();
  for (const proj of projects) {
    const projAlias = aliasOrFallback(proj.name, proj.id);
    if (projAlias !== target) continue;

    const agentTabs = proj.tabs.filter((t) => isAgentTab(t.id));
    if (agentTabs.length === 0) {
      return { ok: false, reason: 'no_agent' };
    }
    if (agentTabs.length > 1) {
      return { ok: false, reason: 'multiple_agents' };
    }
    const tab = agentTabs[0];
    const provider = getAgentProvider(tab.id) ?? 'agent';
    return { ok: true, tabId: tab.id, projectName: proj.name, provider };
  }
  return { ok: false, reason: 'not_found' };
}

/**
 * Build the dynamic `/use_<alias>` slash command list for `setMyCommands`.
 * Only includes projects that currently have an active agent session — no
 * point registering a command that resolves to `no_agent`. Alias collision
 * is silently ignored per MVP (first registered wins, see
 * features/telegram-agent-bridge.md).
 */
export function buildUseCommands(): { command: string; description: string }[] {
  const seen = new Set<string>();
  const out: { command: string; description: string }[] = [];
  for (const proj of getSyncedProjects()) {
    const hasAgent = proj.tabs.some((t) => isAgentTab(t.id));
    if (!hasAgent) continue;
    const alias = aliasOrFallback(proj.name, proj.id);
    if (seen.has(alias)) continue; // collision → first wins
    seen.add(alias);
    out.push({
      command: `use_${alias}`,
      description: `Switch to ${proj.name} agent`,
    });
  }
  return out;
}

/**
 * Format the `/projects` reply listing all projects + their alias and which
 * have agent tabs (open in Shelf vs needs opening first).
 */
export function formatProjectsList(): string {
  const projects = getSyncedProjects();
  if (projects.length === 0) return '_No projects._';
  const lines: string[] = ['*Projects*', ''];
  for (const proj of projects) {
    const alias = aliasOrFallback(proj.name, proj.id);
    const agentTabs = proj.tabs.filter((t) => isAgentTab(t.id));
    if (agentTabs.length === 0) {
      lines.push(`• \`${proj.name}\` — _no agent tab open in Shelf_`);
    } else if (agentTabs.length === 1) {
      const provider = getAgentProvider(agentTabs[0].id) ?? 'agent';
      lines.push(`• \`${proj.name}\` (${provider}) → /use_${alias}`);
    } else {
      lines.push(`• \`${proj.name}\` — _${agentTabs.length} agent tabs, open Shelf to pick_`);
    }
  }
  return lines.join('\n');
}
