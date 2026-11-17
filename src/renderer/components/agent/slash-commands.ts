import { useMemo } from 'react';
import type { Capabilities } from '../../agentTabStore';
import type { SkillCommandMenuEntry } from '@shared/skill-invocation';

/** Finite-option native commands retain their renderer picker path. */
export const OPTIONED_SLASHES: Record<string, 'model' | 'effort' | 'permissionMode'> = {
  model: 'model', effort: 'effort', permission: 'permissionMode',
};
export interface SlashCommand {
  name: string;
  description: string;
  shelf?: SkillCommandMenuEntry;
}
const EMPTY_COMMANDS: SkillCommandMenuEntry[] = [];

/** Native commands dedupe by name; app conflicts remain visible as separate rows. */
export function mergeSlashCommands(capabilities: Capabilities | null, shelfCommands: readonly SkillCommandMenuEntry[]): SlashCommand[] {
  const local = Object.keys(OPTIONED_SLASHES).map(name => ({ name, description:
    name === 'model' ? 'Switch agent model' : name === 'effort' ? 'Set reasoning effort' : 'Set permission mode' }));
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const command of [...(capabilities?.slashCommands ?? []), ...local]) {
    if (!seen.has(command.name)) { seen.add(command.name); commands.push(command); }
  }
  for (const entry of shelfCommands) commands.push({ name: entry.name, description: entry.description, shelf: entry });
  return commands;
}
export function useSlashCommands(capabilities: Capabilities | null, slashFilter: string, shelfCommands = EMPTY_COMMANDS) {
  const allCommands = useMemo(() => mergeSlashCommands(capabilities, shelfCommands), [capabilities, shelfCommands]);
  const filteredCommands = useMemo(() => allCommands.filter(command => !slashFilter || command.name.toLowerCase().startsWith(slashFilter.toLowerCase())), [allCommands, slashFilter]);
  const allCommandNames = useMemo(() => new Set(allCommands.map(command => command.name)), [allCommands]);
  return { allCommands, filteredCommands, allCommandNames };
}
