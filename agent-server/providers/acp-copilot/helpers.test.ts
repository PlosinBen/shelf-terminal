import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCopilotAcpCommand, copilotAcpSkillsRoot } from './helpers';

describe('resolveCopilotAcpCommand', () => {
  it('launches the resolved binary in --acp mode', () => {
    expect(resolveCopilotAcpCommand(() => '/opt/copilot')).toEqual({
      command: '/opt/copilot',
      args: ['--acp'],
    });
  });

  it('fails loud when the binary is missing (no silent fallback)', () => {
    expect(() => resolveCopilotAcpCommand(() => undefined)).toThrow(/copilot CLI not found/);
  });
});

describe('copilotAcpSkillsRoot', () => {
  it('names the per-app copilot root when an appId is present', () => {
    expect(copilotAcpSkillsRoot('app-42')).toBe(
      path.join(os.homedir(), '.shelf', 'apps', 'app-42', 'copilot'),
    );
  });

  it('returns undefined without app context', () => {
    expect(copilotAcpSkillsRoot(undefined)).toBeUndefined();
  });
});
