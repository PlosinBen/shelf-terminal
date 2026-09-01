export const TERMINAL_LAUNCH_KIND = {
  compatibility: 'compatibility',
  interpreter: 'interpreter',
} as const;

export type TerminalLaunchKind = typeof TERMINAL_LAUNCH_KIND[keyof typeof TERMINAL_LAUNCH_KIND];

export interface TerminalLaunchPlan {
  readonly kind: TerminalLaunchKind;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logContext: string;
}

export interface CompatibilityTerminalRequest {
  readonly kind: typeof TERMINAL_LAUNCH_KIND.compatibility;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly requiredEnv: Readonly<Record<string, string>>;
}

export interface InterpreterTerminalRequest {
  readonly kind: typeof TERMINAL_LAUNCH_KIND.interpreter;
  readonly cwd: string;
  readonly interpreter: string;
  readonly interpreterArgs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly requiredEnv: Readonly<Record<string, string>>;
}

export type TerminalLaunchRequest = CompatibilityTerminalRequest | InterpreterTerminalRequest;

export function freezeTerminalLaunchPlan(plan: TerminalLaunchPlan): TerminalLaunchPlan {
  return Object.freeze({
    ...plan,
    args: Object.freeze([...plan.args]),
    env: Object.freeze({ ...plan.env }),
  });
}
