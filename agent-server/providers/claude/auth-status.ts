import { execFile as nodeExecFile } from 'node:child_process';

export const CLAUDE_CLI_AUTH_OUTCOME = {
  AUTHENTICATED: 'authenticated',
  UNAUTHENTICATED: 'unauthenticated',
  UNKNOWN: 'unknown',
} as const;

export type ClaudeCliAuthProbe =
  | { outcome: typeof CLAUDE_CLI_AUTH_OUTCOME.AUTHENTICATED }
  | { outcome: typeof CLAUDE_CLI_AUTH_OUTCOME.UNAUTHENTICATED }
  | { outcome: typeof CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN; error: string };

type ExecFileLike = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

interface ProbeOptions {
  execFile?: ExecFileLike;
  timeoutMs?: number;
}

/**
 * Parse the public `claude auth status --json` result into the provider's
 * auth verdict. Only first-party credentials are represented by `loggedIn`;
 * Bedrock / Vertex / gateway credentials are managed externally and must not
 * be blocked by a Claude OAuth pane.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeCliAuthProbe {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (err) {
    return { outcome: CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN, error: `invalid JSON: ${(err as Error).message}` };
  }

  if (!value || typeof value !== 'object') {
    return { outcome: CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN, error: 'status output is not an object' };
  }
  const status = value as { loggedIn?: unknown; apiProvider?: unknown };
  if (typeof status.loggedIn !== 'boolean' || typeof status.apiProvider !== 'string') {
    return { outcome: CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN, error: 'status output is missing loggedIn/apiProvider' };
  }
  if (status.apiProvider !== 'firstParty') return { outcome: CLAUDE_CLI_AUTH_OUTCOME.AUTHENTICATED };
  return {
    outcome: status.loggedIn
      ? CLAUDE_CLI_AUTH_OUTCOME.AUTHENTICATED
      : CLAUDE_CLI_AUTH_OUTCOME.UNAUTHENTICATED,
  };
}

/** Run the exact provider binary so warmup and the SDK read the same home/env. */
export function probeClaudeCliAuth(
  binaryPath: string | undefined,
  options: ProbeOptions = {},
): Promise<ClaudeCliAuthProbe> {
  const execFile = options.execFile ?? (nodeExecFile as unknown as ExecFileLike);
  return new Promise((resolve) => {
    execFile(
      binaryPath ?? 'claude',
      ['auth', 'status', '--json'],
      { encoding: 'utf8', timeout: options.timeoutMs ?? 8_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          resolve({ outcome: CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN, error: `${error.message}${detail ? `: ${detail}` : ''}` });
          return;
        }
        resolve(parseClaudeAuthStatus(stdout));
      },
    );
  });
}
