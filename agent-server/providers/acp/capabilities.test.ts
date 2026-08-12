import { describe, it, expect } from 'vitest';
import type { SessionConfigOption, SessionModeState, AvailableCommand } from '@agentclientprotocol/sdk';
import { mapSessionCapabilities, currentSelections, mapSessionCapabilitiesWithCurrent, configOptionIdForCategory } from './capabilities';

const configOptions: SessionConfigOption[] = [
  {
    type: 'select', id: 'model', name: 'Model', category: 'model',
    currentValue: 'gpt-5', options: [
      { value: 'gpt-5', name: 'GPT-5' },
      { value: 'gpt-5-codex', name: 'GPT-5 Codex' },
    ],
  },
  {
    type: 'select', id: 'thought', name: 'Reasoning', category: 'thought_level',
    currentValue: 'high', options: [
      { value: 'low', name: 'low' },
      { value: 'high', name: 'high' },
    ],
  },
];

const modes: SessionModeState = {
  currentModeId: 'agent',
  availableModes: [
    { id: 'read-only', name: 'read-only' },
    { id: 'agent', name: 'agent' },
    { id: 'agent-full-access', name: 'agent-full-access' },
  ],
};

const commands: AvailableCommand[] = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'review', description: 'Review changes' },
];

describe('mapSessionCapabilities', () => {
  it('maps a dynamic model list from category=model', () => {
    const caps = mapSessionCapabilities({ configOptions });
    expect(caps.models).toEqual([
      { value: 'gpt-5', displayName: 'GPT-5' },
      { value: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
    ]);
  });

  it('maps effort from category=thought_level, modes from session modes, slash from commands', () => {
    const caps = mapSessionCapabilities({ configOptions, modes, availableCommands: commands });
    expect(caps.effortLevels).toEqual([{ value: 'low', displayName: 'low' }, { value: 'high', displayName: 'high' }]);
    expect(caps.permissionModes.map((m) => m.value)).toEqual(['read-only', 'agent', 'agent-full-access']);
    expect(caps.slashCommands).toEqual([
      { name: 'compact', description: 'Compact the conversation' },
      { name: 'review', description: 'Review changes' },
    ]);
  });

  it('returns empty arrays when the agent advertises nothing', () => {
    expect(mapSessionCapabilities({})).toEqual({
      models: [],
      permissionModes: [],
      permissionControl: { strategy: 'shelf' },
      effortLevels: [],
      slashCommands: [],
    });
  });

  it('reads current selections for seeding the UI', () => {
    expect(currentSelections({ configOptions, modes })).toEqual({
      currentModel: 'gpt-5', currentEffort: 'high', currentPermissionMode: 'agent',
    });
  });

  it('merges option lists AND current selections for the capabilities message', () => {
    const caps = mapSessionCapabilitiesWithCurrent({ configOptions, modes, availableCommands: commands }) as unknown as Record<string, unknown>;
    expect((caps.models as unknown[]).length).toBe(2);
    expect(caps.currentModel).toBe('gpt-5');
    expect(caps.currentEffort).toBe('high');
    expect(caps.currentPermissionMode).toBe('agent');
  });

  it('omits current selections that are absent (no empty keys)', () => {
    const caps = mapSessionCapabilitiesWithCurrent({}) as unknown as Record<string, unknown>;
    expect('currentModel' in caps).toBe(false);
    expect('currentPermissionMode' in caps).toBe(false);
  });

  it('resolves the config option id for a category (for set_config_option)', () => {
    expect(configOptionIdForCategory(configOptions, 'model')).toBe('model');
    expect(configOptionIdForCategory(configOptions, 'thought_level')).toBe('thought');
    expect(configOptionIdForCategory(configOptions, 'nonexistent')).toBeUndefined();
    expect(configOptionIdForCategory(undefined, 'model')).toBeUndefined();
  });
});
