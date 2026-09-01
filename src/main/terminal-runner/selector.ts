import path from 'path';
import type { TerminalLaunchPlan } from '../connector/launch-plan';
import type { TargetFactsResult } from '../connector/target-facts';

export const RUNNER_KIND = {
  zsh: 'zsh',
  bash: 'bash',
  powerShell: 'powershell',
  native: 'native',
} as const;

export type RunnerKind = typeof RUNNER_KIND[keyof typeof RUNNER_KIND];

export type TerminalRunnerSelection =
  | { readonly kind: typeof RUNNER_KIND.zsh; readonly interpreter: string }
  | { readonly kind: typeof RUNNER_KIND.bash; readonly interpreter: string }
  | { readonly kind: typeof RUNNER_KIND.powerShell; readonly interpreter: 'powershell.exe' }
  | { readonly kind: typeof RUNNER_KIND.native; readonly interpreter: string }
  | { readonly kind: typeof RUNNER_KIND.native; readonly compatibilityPlan: TerminalLaunchPlan };

export function selectTerminalRunner(
  targetFacts: TargetFactsResult,
  compatibilityPlan: TerminalLaunchPlan,
): TerminalRunnerSelection {
  if (!targetFacts.ok) {
    return Object.freeze({ kind: RUNNER_KIND.native, compatibilityPlan });
  }

  if (targetFacts.facts.targetOS === 'windows') {
    return Object.freeze({ kind: RUNNER_KIND.powerShell, interpreter: 'powershell.exe' });
  }

  const interpreter = targetFacts.facts.defaultShell;
  switch (path.posix.basename(interpreter)) {
    case RUNNER_KIND.zsh:
      return Object.freeze({ kind: RUNNER_KIND.zsh, interpreter });
    case RUNNER_KIND.bash:
      return Object.freeze({ kind: RUNNER_KIND.bash, interpreter });
    default:
      return Object.freeze({ kind: RUNNER_KIND.native, interpreter });
  }
}
