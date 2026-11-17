export const SKILL_PLUGIN = { NAME: 'shelf-skills', DIRECTORY: '.claude-plugin', MANIFEST: 'plugin.json' } as const;
/** Main-owned registration metadata. Skill instructions remain in SKILL.md. */
export const SKILL_COMMAND_FILE = '.shelf-command.json';
export const SKILL_COMMAND_TEMP_PREFIX = `${SKILL_COMMAND_FILE}.tmp-`;
export const SKILL_COMMAND_VERSION = 1;

export interface SkillCommandDraft {
  alias: string;
  description: string;
}

export interface SkillCommandRegistration extends SkillCommandDraft {
  version: typeof SKILL_COMMAND_VERSION;
  registrationId: string;
}

export interface SkillCommandEntry {
  skillName: string;
  command: SkillCommandRegistration;
  disabled: boolean;
}

export type SkillCommandResult<T> = { ok: true; value: T } | { ok: false; error: string };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateSkillCommandDraft(value: unknown): SkillCommandResult<SkillCommandDraft> {
  if (!object(value) || Object.keys(value).some(key => !['alias', 'description'].includes(key))) {
    return { ok: false, error: 'Command settings must contain only alias and description' };
  }
  if (typeof value.alias !== 'string' || typeof value.description !== 'string') {
    return { ok: false, error: 'Command alias and description must be strings' };
  }
  const alias = value.alias.trim();
  const description = value.description.trim();
  if (alias.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias)) {
    return { ok: false, error: 'Command alias must be lowercase kebab-case, 1–64 characters, without /' };
  }
  if (!description || description.length > 256 || /[\r\n\u2028\u2029]/.test(description)) {
    return { ok: false, error: 'Command description must be a single line, 1–256 characters' };
  }
  return { ok: true, value: { alias, description } };
}

export function validateSkillCommandRegistration(value: unknown): SkillCommandResult<SkillCommandRegistration> {
  if (!object(value) || Object.keys(value).some(key => !['version', 'registrationId', 'alias', 'description'].includes(key))) {
    return { ok: false, error: 'Invalid command registration fields' };
  }
  if (value.version !== SKILL_COMMAND_VERSION) return { ok: false, error: 'Unsupported command registration version' };
  if (typeof value.registrationId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.registrationId)) {
    return { ok: false, error: 'Command registration ID must be a UUID' };
  }
  const checked = validateSkillCommandDraft({ alias: value.alias, description: value.description });
  if (!checked.ok) return checked;
  return { ok: true, value: { version: SKILL_COMMAND_VERSION, registrationId: value.registrationId.toLowerCase(), ...checked.value } };
}

/** Includes descendants of reserved files, so aux operations cannot turn them into folders. */
export function isSkillCommandControlPath(relative: string): boolean {
  const first = relative.split(/[\\/]/)[0].toLowerCase();
  return first === SKILL_COMMAND_FILE || isSkillCommandTemporaryPath(relative);
}

export function isSkillCommandTemporaryPath(relative: string): boolean {
  return relative.split(/[\\/]/)[0].toLowerCase().startsWith(SKILL_COMMAND_TEMP_PREFIX);
}

/** Relative to the plugin root; nested resource files with the same basename stay ordinary resources. */
export function isSkillCommandProjectionPath(relative: string): boolean {
  const parts = relative.split('/');
  return parts.length >= 3 && parts[0] === 'skills' && isSkillCommandControlPath(parts.slice(2).join('/'));
}

export function validateSkillCommandCatalog(entries: readonly SkillCommandEntry[]): string | null {
  const aliases = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const { skillName, command } of entries) {
    for (const [key, seen, label] of [[command.alias, aliases, 'alias'], [command.registrationId, ids, 'registration ID']] as const) {
      const previous = seen.get(key);
      if (previous !== undefined) return `Command ${label} "${key}" conflicts between ${previous} and ${skillName}`;
      seen.set(key, skillName);
    }
  }
  return null;
}

/** Separate from the native slash parser: hyphenated aliases, no multiline dispatch. */
export function parseShelfCommandPrefix(content: string): { alias: string; args: string } | null {
  if (/[\r\n\u2028\u2029]/.test(content)) return null;
  const match = content.trim().match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t]+(.*))?$/);
  if (!match || match[1].length > 64) return null;
  return { alias: match[1], args: (match[2] ?? '').trim() };
}

export const SKILL_COMMAND_RESOLUTION = { NONE: 'none', NATIVE: 'native', MATCH: 'match', ERROR: 'error' } as const;
export type SkillCommandResolution =
  | { kind: typeof SKILL_COMMAND_RESOLUTION.NONE | typeof SKILL_COMMAND_RESOLUTION.NATIVE }
  | { kind: typeof SKILL_COMMAND_RESOLUTION.ERROR; error: string }
  | { kind: typeof SKILL_COMMAND_RESOLUTION.MATCH; skillName: string; registrationId: string; alias: string; args: string };

/** Provider-neutral lookup only; execution binding and native invocation belong to later boundaries. */
export function resolveSkillCommand(
  content: string,
  entries: readonly SkillCommandEntry[],
  nativeNames: ReadonlySet<string>,
): SkillCommandResolution {
  const parsed = parseShelfCommandPrefix(content);
  if (!parsed) return { kind: SKILL_COMMAND_RESOLUTION.NONE };
  if (nativeNames.has(parsed.alias)) return { kind: SKILL_COMMAND_RESOLUTION.NATIVE };
  const matches = entries.filter(entry => entry.command.alias === parsed.alias);
  if (!matches.length) return { kind: SKILL_COMMAND_RESOLUTION.NONE };
  const error = validateSkillCommandCatalog(entries);
  if (error) return { kind: SKILL_COMMAND_RESOLUTION.ERROR, error };
  const entry = matches[0];
  if (entry.disabled) return { kind: SKILL_COMMAND_RESOLUTION.ERROR, error: `Skill ${entry.skillName} is disabled` };
  return { kind: SKILL_COMMAND_RESOLUTION.MATCH, skillName: entry.skillName, registrationId: entry.command.registrationId, ...parsed };
}

/** Registration policy: fixed Shelf/provider controls cannot become app aliases.
 * Dynamic provider command collisions are checked per session at submission. */
export const SKILL_COMMAND_RESERVED_ALIASES: ReadonlySet<string> = new Set([
  'model', 'effort', 'permission', 'status', 'usage', 'mcp', 'skills', 'skill',
  'compact', 'clear', 'new', 'reset', 'review', 'diff', 'goal', 'rename', 'logout', 'ps', 'stop', 'clean',
]);
