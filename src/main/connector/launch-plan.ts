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
}

export function freezeTerminalLaunchPlan(plan: TerminalLaunchPlan): TerminalLaunchPlan {
  return Object.freeze({
    ...plan,
    args: Object.freeze([...plan.args]),
    env: Object.freeze({ ...plan.env }),
  });
}
