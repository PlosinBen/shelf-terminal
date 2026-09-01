import { describe, expect, it } from 'vitest';
import { freezeTerminalLaunchPlan } from '../connector/launch-plan';
import type { TargetFactsResult } from '../connector/target-facts';
import { RUNNER_KIND, selectTerminalRunner } from './selector';

const compatibilityPlan = freezeTerminalLaunchPlan({
  kind: 'compatibility',
  executable: 'ssh',
  args: ['target'],
  cwd: '/home/test',
  env: {},
  logContext: 'test',
});

function facts(defaultShell: string): TargetFactsResult {
  return { ok: true, facts: { targetOS: 'unix', defaultShell } };
}

describe('selectTerminalRunner', () => {
  it.each([
    ['/bin/zsh', RUNNER_KIND.zsh],
    ['/usr/local/bin/bash', RUNNER_KIND.bash],
    ['/bin/sh', RUNNER_KIND.native],
    ['/usr/bin/fish', RUNNER_KIND.native],
  ])('selects %s as %s', (defaultShell, expected) => {
    expect(selectTerminalRunner(facts(defaultShell), compatibilityPlan)).toMatchObject({
      kind: expected,
      interpreter: defaultShell,
    });
  });

  it('selects fixed PowerShell behavior for a positively detected Windows target', () => {
    expect(selectTerminalRunner({
      ok: true,
      facts: { targetOS: 'windows', defaultShell: 'powershell.exe' },
    }, compatibilityPlan)).toEqual({
      kind: RUNNER_KIND.powerShell,
      interpreter: 'powershell.exe',
    });
  });

  it('passes the exact compatibility plan to NativeRunner after probe failure', () => {
    const selection = selectTerminalRunner({
      ok: false,
      reason: 'probe-failed',
      attempts: [],
    }, compatibilityPlan);

    expect(selection).toEqual({ kind: RUNNER_KIND.native, compatibilityPlan });
    expect('compatibilityPlan' in selection && selection.compatibilityPlan).toBe(compatibilityPlan);
  });
});
