import { describe, it, expect } from 'vitest';
import type { SessionModeState } from '@agentclientprotocol/sdk';
import { copilotPermissionModes, copilotModeIdToShelf, shelfToCopilotModeId } from './mode-map';

// Copilot's real modes arrive as full-URL ids.
const modes = {
  currentModeId: 'https://agentclientprotocol.com/protocol/session-modes#agent',
  availableModes: [
    { id: 'https://agentclientprotocol.com/protocol/session-modes#agent', name: 'Agent' },
    { id: 'https://agentclientprotocol.com/protocol/session-modes#plan', name: 'Plan' },
    { id: 'https://agentclientprotocol.com/protocol/session-modes#autopilot', name: 'Autopilot' },
  ],
} as unknown as SessionModeState;

describe('copilot mode-map', () => {
  it('exposes the Shelf-standard permission modes (matches native copilot)', () => {
    expect(copilotPermissionModes().map((m) => m.value)).toEqual(['default', 'bypassPermissions', 'plan']);
  });

  it('maps copilot mode ids → Shelf permission modes', () => {
    expect(copilotModeIdToShelf(modes.availableModes[0].id)).toBe('default');   // agent
    expect(copilotModeIdToShelf(modes.availableModes[1].id)).toBe('plan');      // plan
    expect(copilotModeIdToShelf(modes.availableModes[2].id)).toBe('bypassPermissions'); // autopilot
    expect(copilotModeIdToShelf('bare-agent-style#agent')).toBe('default');
    expect(copilotModeIdToShelf(undefined)).toBeUndefined();
  });

  it('maps Shelf permission modes → the exact copilot mode id to set', () => {
    expect(shelfToCopilotModeId('default', modes)).toBe(modes.availableModes[0].id);
    expect(shelfToCopilotModeId('plan', modes)).toBe(modes.availableModes[1].id);
    expect(shelfToCopilotModeId('bypassPermissions', modes)).toBe(modes.availableModes[2].id);
    // acceptEdits has no copilot equivalent → undefined (caller reports, no silent success).
    expect(shelfToCopilotModeId('acceptEdits', modes)).toBeUndefined();
  });
});
