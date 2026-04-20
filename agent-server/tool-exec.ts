import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Thin ExecFn-compatible wrapper over node's child_process.exec. Used inside
 * agent-server where the process is already running on the target machine —
 * no SSH / Docker hop is needed, just run the command locally.
 */
export const localExec = async (cwd: string, cmd: string): Promise<{ stdout: string; stderr: string }> => {
  try {
    const result = await execAsync(cmd, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      shell: '/bin/sh',
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (err: any) {
    // execAsync rejects on non-zero exit code; surface stderr instead so the
    // tool executor can treat it like any other stderr.
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? String(err),
    };
  }
};
