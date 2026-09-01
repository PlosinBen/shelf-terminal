import type {
  AgentPrefs,
  Connection,
  QuickCommand,
  TabTemplate,
} from './types';

export type ProjectId = string;

export type ReadonlyDeep<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[] :
  T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
  readonly connection: ReadonlyDeep<Connection>;
  readonly maxTabs: number;
  readonly initScript: string | null;
  readonly envPlain: Readonly<Record<string, string>>;
  readonly defaultTabs: readonly ReadonlyDeep<TabTemplate>[];
  readonly quickCommands: readonly ReadonlyDeep<QuickCommand>[];
  readonly featureNoteDir: string | null;
  readonly parentProjectId: ProjectId | null;
  readonly worktreeBranch: string | null;
  readonly baseBranch: string | null;
  readonly defaultAgentProvider: string | null;
  readonly openAgentOnConnect: boolean;
  readonly agentSessionIds: Readonly<Record<string, string>>;
  readonly agentPrefs: Readonly<Record<string, ReadonlyDeep<AgentPrefs>>>;
}

export interface ProjectCreateInput {
  readonly name: string;
  readonly cwd: string;
  readonly connection: ReadonlyDeep<Connection>;
  readonly maxTabs: number;
  readonly initScript?: string | null;
  readonly envPlain?: Readonly<Record<string, string>>;
  readonly defaultTabs?: readonly ReadonlyDeep<TabTemplate>[];
  readonly quickCommands?: readonly ReadonlyDeep<QuickCommand>[];
  readonly featureNoteDir?: string | null;
  readonly parentProjectId?: ProjectId | null;
  readonly worktreeBranch?: string | null;
  readonly baseBranch?: string | null;
  readonly defaultAgentProvider?: string | null;
  readonly openAgentOnConnect?: boolean;
  readonly agentPrefs?: Readonly<Record<string, ReadonlyDeep<AgentPrefs>>>;
}

export interface ProjectDeleteResult {
  readonly cleanupPending: boolean;
  readonly leftover?: {
    readonly targetPath: string;
    readonly reason: string;
  };
}
