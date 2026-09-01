import type { TerminalInitTokens } from '@shared/terminal-init-osc';
import { log } from '@shared/logger';
import type { ConnectorRuntime } from '../connector/runtime';
import type { TerminalLaunchPlan } from '../connector/launch-plan';
import { ensureTargetHistory, type TargetHistorySelection } from './history-path';
import { installZshShim } from './zsh-shim';
import { RUNNER_KIND, type TerminalRunnerSelection } from './selector';

const RUNNER_ENV = {
  nonce: 'SHELF_INIT_NONCE',
  runnerReady: 'SHELF_INIT_RUNNER_READY',
  runnerUnconfirmed: 'SHELF_INIT_RUNNER_UNCONFIRMED',
  initScript: 'SHELF_INIT_SCRIPT',
  initSuccess: 'SHELF_INIT_SCRIPT_SUCCESS',
  initFailure: 'SHELF_INIT_SCRIPT_FAILURE',
  initCancelled: 'SHELF_INIT_SCRIPT_CANCELLED',
  historyFile: 'SHELF_HISTORY_FILE',
} as const;

export interface RunnerLaunchContext {
  readonly runtime: ConnectorRuntime;
  readonly selection: TerminalRunnerSelection;
  readonly cwd: string;
  readonly appId: string;
  readonly projectId: string;
  readonly nonce: string;
  readonly tokens: TerminalInitTokens;
  readonly initScript?: string;
  readonly env?: Record<string, string>;
  readonly requiredEnv?: Record<string, string>;
}

export interface PreparedRunnerLaunch {
  readonly plan: TerminalLaunchPlan;
  readonly mode: 'explicit' | 'native';
  readonly directiveMode: 'shell' | 'none';
  readonly historyIsolation: 'attempted' | 'native' | 'unconfirmed';
}

export interface RunnerDependencies {
  ensureHistory: typeof ensureTargetHistory;
  installZshShim: typeof installZshShim;
}

const DEFAULT_DEPENDENCIES: RunnerDependencies = {
  ensureHistory: ensureTargetHistory,
  installZshShim,
};

export async function prepareRunnerLaunch(
  context: RunnerLaunchContext,
  dependencies: RunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<PreparedRunnerLaunch> {
  switch (context.selection.kind) {
    case RUNNER_KIND.zsh:
      return prepareZsh(context, context.selection.interpreter, dependencies);
    case RUNNER_KIND.bash:
      return prepareBash(context, context.selection.interpreter, dependencies);
    case RUNNER_KIND.powerShell:
      return preparePowerShell(context);
    case RUNNER_KIND.native:
      return prepareNative(context);
  }
}

async function prepareZsh(
  context: RunnerLaunchContext,
  interpreter: string,
  dependencies: RunnerDependencies,
): Promise<PreparedRunnerLaunch> {
  try {
    const history = await dependencies.ensureHistory(
      context.runtime, 'zsh', context.appId, context.projectId,
    );
    await dependencies.installZshShim(
      context.runtime,
      targetHome(history),
      history.zshShim,
    );
    const plan = context.runtime.createInterpreterLaunchPlan(
      context.cwd,
      interpreter,
      ['-l'],
      context.env,
      {
        ...context.requiredEnv,
        ZDOTDIR: history.zshShimDir,
        ...runnerEnvironment(context, history.historyFile),
      },
      [{ source: 'ZDOTDIR', target: 'SHELF_ORIGINAL_ZDOTDIR' }],
    );
    return Object.freeze({
      plan, mode: 'explicit', directiveMode: 'shell', historyIsolation: 'attempted',
    });
  } catch (error) {
    log.error('terminal-history', `zsh isolation setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return plainUnixRunner(context, interpreter);
  }
}

async function prepareBash(
  context: RunnerLaunchContext,
  interpreter: string,
  dependencies: RunnerDependencies,
): Promise<PreparedRunnerLaunch> {
  try {
    const history = await dependencies.ensureHistory(
      context.runtime, 'bash', context.appId, context.projectId,
    );
    const bootstrap = BASH_PROMPT_COMMAND;
    const plan = context.runtime.createInterpreterLaunchPlan(
      context.cwd,
      interpreter,
      ['-l'],
      context.env,
      {
        ...context.requiredEnv,
        HISTFILE: history.historyFile,
        PROMPT_COMMAND: bootstrap,
        ...runnerEnvironment(context, history.historyFile),
      },
      [{ source: 'PROMPT_COMMAND', target: 'SHELF_ORIGINAL_PROMPT_COMMAND' }],
    );
    return Object.freeze({
      plan, mode: 'explicit', directiveMode: 'shell', historyIsolation: 'attempted',
    });
  } catch (error) {
    log.error('terminal-history', `bash isolation setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return plainUnixRunner(context, interpreter);
  }
}

function preparePowerShell(context: RunnerLaunchContext): PreparedRunnerLaunch {
  const plan = context.runtime.createInterpreterLaunchPlan(
    context.cwd,
    'powershell.exe',
    ['-NoExit', '-Command', buildPowerShellBootstrap()],
    context.env,
    { ...context.requiredEnv, ...runnerEnvironment(context) },
    [],
  );
  return Object.freeze({
    plan, mode: 'explicit', directiveMode: 'none', historyIsolation: 'native',
  });
}

function prepareNative(context: RunnerLaunchContext): PreparedRunnerLaunch {
  const plan = 'compatibilityPlan' in context.selection
    ? context.selection.compatibilityPlan
    : context.runtime.createInterpreterLaunchPlan(
      context.cwd,
      context.selection.interpreter,
      ['-l'],
      context.env,
      context.requiredEnv,
      [],
    );
  return Object.freeze({ plan, mode: 'native', directiveMode: 'none', historyIsolation: 'native' });
}

function plainUnixRunner(context: RunnerLaunchContext, interpreter: string): PreparedRunnerLaunch {
  const plan = context.runtime.createInterpreterLaunchPlan(
    context.cwd, interpreter, ['-l'], context.env, context.requiredEnv, [],
  );
  return Object.freeze({
    plan, mode: 'native', directiveMode: 'none', historyIsolation: 'unconfirmed',
  });
}

function runnerEnvironment(
  context: RunnerLaunchContext,
  historyFile?: string,
): Record<string, string> {
  return {
    [RUNNER_ENV.nonce]: context.nonce,
    [RUNNER_ENV.runnerReady]: context.tokens.runnerReady,
    [RUNNER_ENV.runnerUnconfirmed]: context.tokens.runnerIsolationUnconfirmed,
    [RUNNER_ENV.initScript]: context.initScript ?? '',
    [RUNNER_ENV.initSuccess]: context.tokens.initScriptSuccess,
    [RUNNER_ENV.initFailure]: context.tokens.initScriptFailure,
    [RUNNER_ENV.initCancelled]: context.tokens.initScriptCancelled,
    ...(historyFile ? { [RUNNER_ENV.historyFile]: historyFile } : {}),
  };
}

function targetHome(history: TargetHistorySelection): string {
  const marker = '/.shelf/';
  const index = history.projectRoot.indexOf(marker);
  if (index <= 0) throw new Error('Cannot derive target home from history namespace');
  return history.projectRoot.slice(0, index);
}

function buildBashPromptCommand(): string {
  return [
    '__shelf_runner_token="$SHELF_INIT_RUNNER_READY"',
    'HISTFILE="$SHELF_HISTORY_FILE"',
    'history -c',
    'history -r "$SHELF_HISTORY_FILE" || __shelf_runner_token="$SHELF_INIT_RUNNER_UNCONFIRMED"',
    '[[ "$HISTFILE" == "$SHELF_HISTORY_FILE" ]] || __shelf_runner_token="$SHELF_INIT_RUNNER_UNCONFIRMED"',
    "printf '\\033]6973;terminal-init;1;%s\\007' \"$__shelf_runner_token\"",
    'IFS= read -r __shelf_directive',
    '__shelf_original_prompt="$SHELF_ORIGINAL_PROMPT_COMMAND"',
    'PROMPT_COMMAND="$SHELF_ORIGINAL_PROMPT_COMMAND"',
    'if [[ "$__shelf_directive" == ": __SHELF_INIT_DIRECTIVE__ ${SHELF_INIT_NONCE} normal" && -n "$SHELF_INIT_SCRIPT" ]]; then eval -- "$SHELF_INIT_SCRIPT"; __shelf_status=$?; if (( __shelf_status == 0 )); then __shelf_token="$SHELF_INIT_SCRIPT_SUCCESS"; elif (( __shelf_status == 130 )); then __shelf_token="$SHELF_INIT_SCRIPT_CANCELLED"; else __shelf_token="$SHELF_INIT_SCRIPT_FAILURE"; fi; printf \'\\033]6973;terminal-init;1;%s\\007\' "$__shelf_token"; fi',
    'unset SHELF_INIT_NONCE SHELF_INIT_RUNNER_READY SHELF_INIT_RUNNER_UNCONFIRMED SHELF_INIT_SCRIPT SHELF_INIT_SCRIPT_SUCCESS SHELF_INIT_SCRIPT_FAILURE SHELF_INIT_SCRIPT_CANCELLED SHELF_HISTORY_FILE',
    'unset __shelf_runner_token __shelf_directive __shelf_status __shelf_token',
    '[[ -n "$__shelf_original_prompt" ]] && eval -- "$__shelf_original_prompt"',
    'unset __shelf_original_prompt SHELF_ORIGINAL_PROMPT_COMMAND',
  ].join('; ');
}

export const BASH_PROMPT_COMMAND = buildBashPromptCommand();

function buildPowerShellBootstrap(): string {
  return [
    "$__shelfEsc=[char]27",
    "$__shelfBel=[char]7",
    '[Console]::Out.Write("$__shelfEsc]6973;terminal-init;1;$env:SHELF_INIT_RUNNER_READY$__shelfBel")',
    'if ($env:SHELF_INIT_SCRIPT) {',
    '  try { . ([ScriptBlock]::Create($env:SHELF_INIT_SCRIPT)); $__shelfToken = if ($?) { $env:SHELF_INIT_SCRIPT_SUCCESS } else { $env:SHELF_INIT_SCRIPT_FAILURE } }',
    '  catch [System.Management.Automation.PipelineStoppedException] { $__shelfToken=$env:SHELF_INIT_SCRIPT_CANCELLED }',
    '  catch { $__shelfToken=$env:SHELF_INIT_SCRIPT_FAILURE }',
    '  [Console]::Out.Write("$__shelfEsc]6973;terminal-init;1;$__shelfToken$__shelfBel")',
    '}',
    "Remove-Item Env:SHELF_INIT_NONCE,Env:SHELF_INIT_RUNNER_READY,Env:SHELF_INIT_RUNNER_UNCONFIRMED,Env:SHELF_INIT_SCRIPT,Env:SHELF_INIT_SCRIPT_SUCCESS,Env:SHELF_INIT_SCRIPT_FAILURE,Env:SHELF_INIT_SCRIPT_CANCELLED -ErrorAction SilentlyContinue",
    'Remove-Variable __shelfEsc,__shelfBel,__shelfToken -ErrorAction SilentlyContinue',
  ].join(' ');
}
