import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCopilotAcpCommand, copilotConfigHome, copilotAcpEnv } from './helpers';

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

describe('copilotConfigHome', () => {
  it('names the per-app COPILOT_HOME when an appId is present', () => {
    expect(copilotConfigHome('app-42')).toBe(
      path.join(os.homedir(), '.shelf', 'apps', 'app-42', 'copilot'),
    );
  });

  it('returns undefined without app context', () => {
    expect(copilotConfigHome(undefined)).toBeUndefined();
  });
});

describe('copilotAcpEnv', () => {
  it('sets COPILOT_HOME to the per-app config-home, preserving the base env', () => {
    const env = copilotAcpEnv('app-42', { PATH: '/usr/bin' });
    expect(env.COPILOT_HOME).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-42', 'copilot'));
    expect(env.PATH).toBe('/usr/bin');
  });

  it('returns the base env unchanged (no COPILOT_HOME) without app context', () => {
    const base = { PATH: '/usr/bin' };
    const env = copilotAcpEnv(undefined, base);
    expect(env).toBe(base);
    expect(env.COPILOT_HOME).toBeUndefined();
  });
});
