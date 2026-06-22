/**
 * "Loaded MCP / Skills" visibility — normalize each provider's raw SDK shapes
 * into a common form + format a `/mcp` `/skills` markdown card.
 *
 * Why: `/mcp` and `/skills` are interactive-TUI-only in both CLIs (NOT
 * dispatchable through the SDK/headless). So the provider intercepts them
 * itself and prints a read-only listing built from the SDK's structured data
 * (Claude `mcpServerStatus()` / `supportedCommands()`; Copilot `skills_loaded`
 * / `mcp_servers_loaded` events) — captured + normalized ONCE at init.
 *
 * Pure (no SDK imports / no I/O) so the normalize + format logic is unit-tested
 * without spinning up a backend. See .agent/features/mcp-skills-visibility.md.
 */

/** Normalized MCP server (cross-provider). `source` is Copilot-only. */
export interface NormalizedMcpServer {
  name: string;
  status: string;
  error?: string;
  source?: string;
}

/** Normalized skill (cross-provider). `source`/`enabled` are Copilot-only —
 *  Claude's SlashCommand carries neither. */
export interface NormalizedSkill {
  name: string;
  description?: string;
  source?: 'project' | 'app' | 'personal' | 'other';
  enabled?: boolean;
}

// ── Claude ──────────────────────────────────────────────────────────────────

/** Claude `mcpServerStatus()` → normalized. Loose input type so this module
 *  doesn't depend on the SDK package. */
export function normalizeClaudeMcpServers(
  raw: Array<{ name: string; status: string; error?: string }>,
): NormalizedMcpServer[] {
  return raw.map((s) => ({
    name: s.name,
    status: s.status,
    ...(s.error ? { error: s.error } : {}),
  }));
}

/**
 * Claude has no skill-listing API — skills ARE slash commands
 * (`.claude/skills/<name>/SKILL.md` = `/name`) and `supportedCommands()`
 * doesn't tag source or skill-vs-command. So Claude `/skills` = the available
 * commands MINUS the known built-ins (clear/compact/… + our own intercepts) =
 * the user-added commands + skills. No source (SDK doesn't provide it).
 */
export function normalizeClaudeCommandsAsSkills(
  raw: Array<{ name: string; description?: string }>,
  builtinNames: Set<string>,
): NormalizedSkill[] {
  return raw
    .filter((c) => !builtinNames.has(c.name))
    .map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) }));
}

// ── Copilot ─────────────────────────────────────────────────────────────────

/** Map Copilot's `SkillSource` to our normalized source bucket. `custom` =
 *  a configured skillDirectory, which for Shelf is the app-level skills dir. */
export function normalizeCopilotSkillSource(source?: string): NormalizedSkill['source'] {
  switch (source) {
    case 'project':
    case 'inherited':
      return 'project';
    case 'custom':
      return 'app';
    case 'personal-copilot':
    case 'personal-agents':
    case 'personal-claude':
      return 'personal';
    case undefined:
      return undefined;
    default:
      return 'other'; // plugin / builtin / remote / unknown
  }
}

export function normalizeCopilotSkills(
  raw: Array<{ name: string; description?: string; enabled?: boolean; source?: string }>,
): NormalizedSkill[] {
  return raw.map((s) => ({
    name: s.name,
    ...(s.description ? { description: s.description } : {}),
    ...(normalizeCopilotSkillSource(s.source) ? { source: normalizeCopilotSkillSource(s.source) } : {}),
    ...(typeof s.enabled === 'boolean' ? { enabled: s.enabled } : {}),
  }));
}

export function normalizeCopilotMcpServers(
  raw: Array<{ name: string; status?: string; error?: string; source?: string }>,
): NormalizedMcpServer[] {
  return raw.map((s) => ({
    name: s.name,
    status: s.status ?? 'unknown',
    ...(s.error ? { error: s.error } : {}),
    ...(s.source ? { source: s.source } : {}),
  }));
}

// ── Markdown card formatting (pure) ─────────────────────────────────────────

/** `/mcp` card body. Empty → an explicit "none" line, never blank. */
export function formatMcpCard(servers: NormalizedMcpServer[]): string {
  if (servers.length === 0) return 'No MCP servers loaded in this session.';
  const lines = servers.map((s) => {
    const bits = [`**${s.name}**`, `— ${s.status}`];
    if (s.error) bits.push(`(${s.error})`);
    if (s.source) bits.push(`· ${s.source}`);
    return `- ${bits.join(' ')}`;
  });
  return `${servers.length} MCP server${servers.length > 1 ? 's' : ''}:\n${lines.join('\n')}`;
}

/** `/skills` card body. Empty → an explicit "none" line, never blank. */
export function formatSkillsCard(skills: NormalizedSkill[]): string {
  if (skills.length === 0) return 'No skills loaded in this session.';
  const lines = skills.map((s) => {
    const bits = [`**${s.name}**`];
    if (s.source) bits.push(`· ${s.source}`);
    if (s.enabled === false) bits.push('(disabled)');
    if (s.description) bits.push(`— ${s.description}`);
    return `- ${bits.join(' ')}`;
  });
  return `${skills.length} skill${skills.length > 1 ? 's' : ''}:\n${lines.join('\n')}`;
}
