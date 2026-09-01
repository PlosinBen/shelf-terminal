import { describe, expect, it, vi } from 'vitest';
import { installZshShim, ZSH_SHIM_CONTENT, ZSH_SHIM_VERSION_MARKER } from './zsh-shim';

describe('zsh shim', () => {
  it('restores and sources the original ZDOTDIR before installing one-shot history bootstrap', () => {
    expect(ZSH_SHIM_CONTENT).toContain('export ZDOTDIR="$SHELF_ORIGINAL_ZDOTDIR"');
    expect(ZSH_SHIM_CONTENT).toContain('source "$ZDOTDIR/.zshenv"');
    expect(ZSH_SHIM_CONTENT).toContain('fc -p "$SHELF_HISTORY_FILE"');
    expect(ZSH_SHIM_CONTENT).toContain('add-zsh-hook -d precmd __shelf_terminal_init');
    expect(ZSH_SHIM_CONTENT).toContain(': __SHELF_INIT_DIRECTIVE__ ${SHELF_INIT_NONCE} normal');
    expect(ZSH_SHIM_CONTENT).toContain('unset SHELF_INIT_NONCE');
  });

  it('does not rewrite an already valid immutable version', async () => {
    const runtime = {
      exec: vi.fn((_cwd: string, _cmd: string) => Promise.resolve({ stdout: '', stderr: '' })),
      putFile: vi.fn((_path: string, _buffer: Buffer) => Promise.resolve()),
    };

    await installZshShim(runtime, '/home/ben', '/home/ben/.shelf/apps/app-1/shell-init/zsh/v1/.zshenv');

    expect(runtime.exec).toHaveBeenCalledOnce();
    expect(runtime.exec.mock.calls[0][1]).toContain(ZSH_SHIM_VERSION_MARKER);
    expect(runtime.putFile).not.toHaveBeenCalled();
  });

  it('places through a temporary path and verifies when the version is absent', async () => {
    const runtime = {
      exec: vi.fn()
        .mockRejectedValueOnce(new Error('missing'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' }),
      putFile: vi.fn((_path: string, _buffer: Buffer) => Promise.resolve()),
    };
    const shim = '/home/ben/.shelf/apps/app-1/shell-init/zsh/v1/.zshenv';

    await installZshShim(runtime, '/home/ben', shim);

    expect(runtime.putFile).toHaveBeenCalledOnce();
    expect(runtime.putFile.mock.calls[0][0]).toMatch(/\.zshenv\.tmp-[A-Za-z0-9-]+$/);
    expect(runtime.putFile.mock.calls[0][1].toString('utf8')).toBe(ZSH_SHIM_CONTENT);
    expect(runtime.exec.mock.calls[1][1]).toContain(`mv`);
    expect(runtime.exec.mock.calls[1][1]).toContain(ZSH_SHIM_VERSION_MARKER);
  });
});
