import { describe, expect, it, vi } from 'vitest';
import { createTerminalInitTokens } from '@shared/terminal-init-osc';
import { freezeTerminalLaunchPlan, type TerminalLaunchPlan } from '../connector/launch-plan';
import { RUNNER_KIND, type TerminalRunnerSelection } from './selector';
import { prepareRunnerLaunch } from './runners';

function compatibilityPlan(): TerminalLaunchPlan {
  return freezeTerminalLaunchPlan({
    kind: 'compatibility', executable: 'ssh', args: ['opaque'], cwd: '/home/test', env: {}, logContext: 'test',
  });
}

function runtime() {
  return {
    createInterpreterLaunchPlan: vi.fn((
      cwd: string,
      interpreter: string,
      interpreterArgs: readonly string[],
      env: Record<string, string>,
      requiredEnv: Record<string, string>,
      preserveEnv: readonly { source: string; target: string }[],
    ) => freezeTerminalLaunchPlan({
      kind: 'interpreter', executable: interpreter, args: interpreterArgs, cwd,
      env: { ...env, ...requiredEnv }, logContext: JSON.stringify(preserveEnv),
    })),
  };
}

const tokens = createTerminalInitTokens('fixed_nonce');
const history = {
  projectRoot: '/home/ben/.shelf/apps/app-1/projects/project-1',
  historyRoot: '/home/ben/.shelf/apps/app-1/projects/project-1/shell-history',
  zsh: '/home/ben/.shelf/apps/app-1/projects/project-1/shell-history/zsh',
  bash: '/home/ben/.shelf/apps/app-1/projects/project-1/shell-history/bash',
  zshShimDir: '/home/ben/.shelf/apps/app-1/shell-init/zsh/v1',
  zshShim: '/home/ben/.shelf/apps/app-1/shell-init/zsh/v1/.zshenv',
};

function context(selection: TerminalRunnerSelection) {
  return {
    runtime: runtime() as any,
    selection,
    cwd: '/work',
    appId: 'app-1',
    projectId: 'project-1',
    nonce: 'fixed_nonce',
    tokens,
    initScript: 'export READY=1',
    env: { PROJECT_ENV: 'value' },
    requiredEnv: { BROWSER: '/shelf-browser' },
  };
}

describe('prepareRunnerLaunch', () => {
  it('passes an opaque compatibility plan through NativeRunner unchanged', async () => {
    const plan = compatibilityPlan();
    const prepared = await prepareRunnerLaunch(context({ kind: RUNNER_KIND.native, compatibilityPlan: plan }));

    expect(prepared.plan).toBe(plan);
    expect(prepared.mode).toBe('native');
  });

  it('launches a resolved unsupported shell once with Native policy', async () => {
    const ctx = context({ kind: RUNNER_KIND.native, interpreter: '/usr/bin/fish' });
    const prepared = await prepareRunnerLaunch(ctx);

    expect(ctx.runtime.createInterpreterLaunchPlan).toHaveBeenCalledWith(
      '/work', '/usr/bin/fish', ['-l'], { PROJECT_ENV: 'value' }, { BROWSER: '/shelf-browser' }, [],
    );
    expect(prepared.mode).toBe('native');
  });

  it('prepares zsh with app-level ZDOTDIR shim and project history', async () => {
    const ctx = context({ kind: RUNNER_KIND.zsh, interpreter: '/bin/zsh' });
    const ensureHistory = vi.fn(() => Promise.resolve({ ...history, historyFile: history.zsh }));
    const installShim = vi.fn(() => Promise.resolve());

    const prepared = await prepareRunnerLaunch(ctx, { ensureHistory, installZshShim: installShim });

    expect(ensureHistory).toHaveBeenCalledWith(ctx.runtime, 'zsh', 'app-1', 'project-1');
    expect(installShim).toHaveBeenCalledWith(ctx.runtime, '/home/ben', history.zshShim);
    const requiredEnv = ctx.runtime.createInterpreterLaunchPlan.mock.calls[0][4];
    expect(requiredEnv).toMatchObject({
      ZDOTDIR: history.zshShimDir,
      SHELF_HISTORY_FILE: history.zsh,
      SHELF_INIT_NONCE: 'fixed_nonce',
    });
    expect(ctx.runtime.createInterpreterLaunchPlan.mock.calls[0][5]).toEqual([
      { source: 'ZDOTDIR', target: 'SHELF_ORIGINAL_ZDOTDIR' },
    ]);
    expect(prepared).toMatchObject({ mode: 'explicit', directiveMode: 'shell', historyIsolation: 'attempted' });
  });

  it('prepares bash through HISTFILE and a one-shot PROMPT_COMMAND without a shim', async () => {
    const ctx = context({ kind: RUNNER_KIND.bash, interpreter: '/bin/bash' });
    const ensureHistory = vi.fn(() => Promise.resolve({ ...history, historyFile: history.bash }));

    const prepared = await prepareRunnerLaunch(ctx, { ensureHistory, installZshShim: vi.fn() });

    const requiredEnv = ctx.runtime.createInterpreterLaunchPlan.mock.calls[0][4];
    expect(requiredEnv.HISTFILE).toBe(history.bash);
    expect(requiredEnv.PROMPT_COMMAND).toContain('history -c');
    expect(requiredEnv.PROMPT_COMMAND).toContain('history -r "$SHELF_HISTORY_FILE"');
    expect(requiredEnv.PROMPT_COMMAND).toContain('$SHELF_ORIGINAL_PROMPT_COMMAND');
    expect(ctx.runtime.createInterpreterLaunchPlan.mock.calls[0][5]).toEqual([
      { source: 'PROMPT_COMMAND', target: 'SHELF_ORIGINAL_PROMPT_COMMAND' },
    ]);
    expect(prepared).toMatchObject({ mode: 'explicit', directiveMode: 'shell', historyIsolation: 'attempted' });
  });

  it('preserves powershell.exe and native history while using controlled readiness', async () => {
    const ctx = context({ kind: RUNNER_KIND.powerShell, interpreter: 'powershell.exe' });
    const prepared = await prepareRunnerLaunch(ctx);
    const call = ctx.runtime.createInterpreterLaunchPlan.mock.calls[0];

    expect(call[1]).toBe('powershell.exe');
    expect(call[2]).toEqual(['-NoExit', '-Command', expect.stringContaining('terminal-init')]);
    expect(call[4]).not.toHaveProperty('HISTFILE');
    expect(prepared).toMatchObject({ mode: 'explicit', directiveMode: 'none', historyIsolation: 'native' });
  });
});
