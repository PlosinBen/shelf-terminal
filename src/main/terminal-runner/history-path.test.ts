import { describe, expect, it, vi } from 'vitest';
import {
  deriveTargetHistoryPaths,
  ensureTargetHistory,
  removeTargetProjectHistory,
} from './history-path';

describe('target history namespace', () => {
  it('derives separate zsh and bash files under the target-side project namespace', () => {
    expect(deriveTargetHistoryPaths('/home/ben', 'app-1', 'project-2')).toEqual({
      projectRoot: '/home/ben/.shelf/apps/app-1/projects/project-2',
      historyRoot: '/home/ben/.shelf/apps/app-1/projects/project-2/shell-history',
      zsh: '/home/ben/.shelf/apps/app-1/projects/project-2/shell-history/zsh',
      bash: '/home/ben/.shelf/apps/app-1/projects/project-2/shell-history/bash',
      zshShimDir: '/home/ben/.shelf/apps/app-1/shell-init/zsh/v1',
      zshShim: '/home/ben/.shelf/apps/app-1/shell-init/zsh/v1/.zshenv',
    });
  });

  it('rejects non-absolute homes and unsafe namespace identifiers', () => {
    expect(() => deriveTargetHistoryPaths('~', 'app-1', 'project-2')).toThrow('absolute');
    expect(() => deriveTargetHistoryPaths('/home/ben', '../app', 'project-2')).toThrow('appId');
    expect(() => deriveTargetHistoryPaths('/home/ben', 'app-1', 'project/two')).toThrow('projectId');
  });

  it('creates only the selected shell history file with target-user permissions', async () => {
    const runtime = {
      homePath: vi.fn(() => Promise.resolve('/home/ben')),
      exec: vi.fn((_cwd: string, _cmd: string) => Promise.resolve({ stdout: '', stderr: '' })),
    };

    const result = await ensureTargetHistory(runtime, 'bash', 'app-1', 'project-2');

    expect(result.historyFile).toBe('/home/ben/.shelf/apps/app-1/projects/project-2/shell-history/bash');
    expect(runtime.exec).toHaveBeenCalledOnce();
    expect(runtime.exec.mock.calls[0][1]).toContain("touch '/home/ben/.shelf/apps/app-1/projects/project-2/shell-history/bash'");
    expect(runtime.exec.mock.calls[0][1]).not.toContain('shell-history/zsh');
    expect(runtime.exec.mock.calls[0][1]).toContain('chmod 600');
  });

  it('removes the opaque project root only after resolving the target home', async () => {
    const runtime = {
      homePath: vi.fn(() => Promise.resolve('/home/ben')),
      exec: vi.fn((_cwd: string, _cmd: string) => Promise.resolve({ stdout: '', stderr: '' })),
    };

    const removedPath = await removeTargetProjectHistory(runtime, 'app-1', 'project-2');

    expect(removedPath).toBe('/home/ben/.shelf/apps/app-1/projects/project-2');
    expect(runtime.exec).toHaveBeenCalledWith(
      '/home/ben',
      "rm -rf -- '/home/ben/.shelf/apps/app-1/projects/project-2'",
    );
  });
});
