import { useMemo } from 'react';
import type { Capabilities } from '../../agentTabStore';

/**
 * Slash commands whose arguments come from a finite option list known to the
 * renderer (via capabilities). Typing `/{cmd}` without args opens an inline
 * picker — saves a backend round-trip just to fetch options. Typing
 * `/{cmd} value` falls through to `agent:send` and is dispatched by the
 * provider's own slash handler.
 *
 * Value is the picker key used by SelectionPanel (differs from cmd name
 * when the slash uses a shorter form, e.g. /permission → permissionMode).
 */
export const OPTIONED_SLASHES: Record<string, 'model' | 'effort' | 'permissionMode'> = {
  model: 'model',
  effort: 'effort',
  permission: 'permissionMode',
};

export interface SlashCommand {
  name: string;
  description: string;
}

/**
 * Slash autocomplete command set: union of provider-declared agent slashes and
 * renderer-known optioned slashes (model/effort/permission), deduped.
 * `filteredCommands` is the prefix-filtered view; `allCommandNames` is the
 * O(1) exact-match set used to close the menu.
 */
export function useSlashCommands(capabilities: Capabilities | null, slashFilter: string) {
  const allCommands = useMemo<SlashCommand[]>(() => {
    const providerCmds = capabilities?.slashCommands ?? [];
    const localCmds = Object.keys(OPTIONED_SLASHES).map((name) => {
      const description =
        name === 'model' ? 'Switch agent model' :
        name === 'effort' ? 'Set reasoning effort' :
        name === 'permission' ? 'Set permission mode' :
        '';
      return { name, description };
    });
    const seen = new Set<string>();
    const merged: SlashCommand[] = [];
    for (const cmd of [...providerCmds, ...localCmds]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      merged.push(cmd);
    }
    return merged;
  }, [capabilities]);

  const filteredCommands = useMemo(() => {
    return allCommands.filter(
      (cmd) => !slashFilter || cmd.name.toLowerCase().startsWith(slashFilter.toLowerCase()),
    );
  }, [allCommands, slashFilter]);

  const allCommandNames = useMemo(
    () => new Set(allCommands.map((c) => c.name)),
    [allCommands],
  );

  return { allCommands, filteredCommands, allCommandNames };
}
