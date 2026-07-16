// Capabilities mapping — shared acp/ toolkit (protocol extraction, semantics-free).
//
// Maps an ACP session's advertised state (modes + config options + available
// commands) onto Shelf's ProviderCapabilities. The model list is DYNAMIC —
// agent-owned via config options (category=model) — so Shelf never ships a
// static model registry for ACP agents. category=thought_level → effort levels;
// session modes → permission modes; available_commands → slash commands.

import type {
  SessionModeState,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectGroup,
  AvailableCommand,
} from '@agentclientprotocol/sdk';
import type { ProviderCapabilities, CycleOption } from '../types';

export interface AcpSessionCapabilitiesInput {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
  availableCommands?: AvailableCommand[] | null;
}

/** Flatten a select option list (grouped or flat) to its leaf options. */
function flattenSelectOptions(
  options: Array<SessionConfigSelectOption> | Array<SessionConfigSelectGroup>,
): SessionConfigSelectOption[] {
  const out: SessionConfigSelectOption[] = [];
  for (const o of options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>) {
    if ('options' in o && Array.isArray(o.options)) out.push(...o.options);
    else if ('value' in o) out.push(o);
  }
  return out;
}

/** The config option `id` for the first select option in a category (for
 *  `session/set_config_option`). e.g. category 'model' → 'model', 'thought_level'
 *  → 'reasoning_effort' (copilot). Undefined if the agent advertises none. */
export function configOptionIdForCategory(
  configOptions: SessionConfigOption[] | null | undefined,
  category: string,
): string | undefined {
  return configOptions?.find((c) => c.category === category && c.type === 'select')?.id;
}

/** Cycle options for the first select config option in a given category. */
function selectOptionsForCategory(
  configOptions: SessionConfigOption[] | null | undefined,
  category: string,
): CycleOption[] {
  const opt = configOptions?.find((c) => c.category === category && c.type === 'select');
  if (!opt || opt.type !== 'select') return [];
  return flattenSelectOptions(opt.options).map((o) => ({ value: o.value, displayName: o.name }));
}

/** Map ACP session state → ProviderCapabilities (pure). */
export function mapSessionCapabilities(input: AcpSessionCapabilitiesInput): ProviderCapabilities {
  const effortLevels = selectOptionsForCategory(input.configOptions, 'thought_level');
  const models = selectOptionsForCategory(input.configOptions, 'model').map((m) => ({
    value: m.value,
    displayName: m.displayName,
  }));
  const permissionModes: CycleOption[] = (input.modes?.availableModes ?? []).map((m) => ({
    value: m.id,
    displayName: m.name,
  }));
  const slashCommands = (input.availableCommands ?? []).map((c) => ({
    name: c.name,
    description: c.description,
  }));
  return { models, permissionModes, effortLevels, slashCommands };
}

/**
 * Capabilities PLUS the agent's current model/effort/mode selections, ready to
 * spread into the `capabilities` wire message. The status bar needs the current
 * values to display the active model/permission-mode — without them it shows an
 * empty slot even though the option lists are populated. Both ACP backends need
 * this glue (shared-layer concern, not per-provider).
 */
export function mapSessionCapabilitiesWithCurrent(input: AcpSessionCapabilitiesInput): ProviderCapabilities {
  const caps = mapSessionCapabilities(input);
  const cur = currentSelections(input);
  return {
    ...caps,
    ...(cur.currentModel ? { currentModel: cur.currentModel } : {}),
    ...(cur.currentEffort ? { currentEffort: cur.currentEffort } : {}),
    ...(cur.currentPermissionMode ? { currentPermissionMode: cur.currentPermissionMode } : {}),
  };
}

/** Current selections (for seeding the renderer's active model/effort/mode). */
export function currentSelections(input: AcpSessionCapabilitiesInput): {
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode?: string;
} {
  const modelOpt = input.configOptions?.find((c) => c.category === 'model' && c.type === 'select');
  const effortOpt = input.configOptions?.find((c) => c.category === 'thought_level' && c.type === 'select');
  return {
    currentModel: modelOpt?.type === 'select' ? modelOpt.currentValue : undefined,
    currentEffort: effortOpt?.type === 'select' ? effortOpt.currentValue : undefined,
    currentPermissionMode: input.modes?.currentModeId,
  };
}
