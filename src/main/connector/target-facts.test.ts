import { describe, expect, it, vi } from 'vitest';
import type { Connector, ExecResult, Shell } from './types';
import { ConnectorRuntime } from './runtime';
import {
  TargetFactsResolver,
  encodeTargetFactsFrame,
  type TargetFacts,
} from './target-facts';
import { toConnectorConfig } from './config';

function runtimeWithExec(exec: (cwd: string, cmd: string) => Promise<ExecResult>): ConnectorRuntime {
  const connector: Connector = {
    createShell: () => ({
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
      write() {}, resize() {}, kill() {},
    } satisfies Shell),
    isConnected: () => Promise.resolve(true), connect: () => Promise.resolve(), exec,
    listDir: (path) => Promise.resolve({ path, entries: [] }),
    homePath: () => Promise.resolve('/home/test'),
    uploadFile: (_cwd, filename) => Promise.resolve(filename), putFile: () => Promise.resolve(),
    cleanupSession: () => Promise.resolve(0), clearUploads: () => Promise.resolve(0),
    getUploadsSize: () => Promise.resolve({ totalBytes: 0, fileCount: 0 }),
  };
  return new ConnectorRuntime(toConnectorConfig({ type: 'local' }), connector);
}

describe('TargetFactsResolver', () => {
  const facts: TargetFacts = { targetOS: 'unix', defaultShell: '/bin/zsh' };

  it('accepts one nonce-bound frame surrounded by ordinary stdout noise', async () => {
    const exec = vi.fn(() => Promise.resolve({
      stdout: `profile banner\n${encodeTargetFactsFrame('fixed-nonce', facts)}\ntrailing output\n`,
      stderr: '',
    }));
    const resolver = new TargetFactsResolver({ nonce: () => 'fixed-nonce' });

    await expect(resolver.resolve(runtimeWithExec(exec))).resolves.toEqual({ ok: true, facts });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight probe and caches its successful result', async () => {
    let finish!: (value: ExecResult) => void;
    const exec = vi.fn(() => new Promise<ExecResult>((resolve) => { finish = resolve; }));
    const runtime = runtimeWithExec(exec);
    const resolver = new TargetFactsResolver({ nonce: () => 'fixed-nonce' });

    const first = resolver.resolve(runtime);
    const second = resolver.resolve(runtime);
    finish({ stdout: encodeTargetFactsFrame('fixed-nonce', facts), stderr: '' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, facts }, { ok: true, facts },
    ]);
    await resolver.resolve(runtime);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('caches failure after all dialect candidates fail', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: 'not a frame', stderr: 'sh error' })
      .mockRejectedValueOnce(new Error('powershell unavailable'));
    const runtime = runtimeWithExec(exec);
    const resolver = new TargetFactsResolver({ nonce: () => 'fixed-nonce' });

    const first = await resolver.resolve(runtime);
    const second = await resolver.resolve(runtime);

    expect(first.ok).toBe(false);
    expect(second).toBe(first);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate, malformed, or nonce-mismatched protocol frames', async () => {
    const invalidOutputs = [
      `${encodeTargetFactsFrame('fixed-nonce', facts)}\n${encodeTargetFactsFrame('fixed-nonce', facts)}`,
      '__SHELF_TARGET_FACTS_V1__:fixed-nonce:not-base64!',
      encodeTargetFactsFrame('other-nonce', facts),
    ];

    for (const stdout of invalidOutputs) {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout, stderr: '' })
        .mockRejectedValueOnce(new Error('second dialect failed'));
      const result = await new TargetFactsResolver({ nonce: () => 'fixed-nonce' })
        .resolve(runtimeWithExec(exec));
      expect(result.ok).toBe(false);
    }
  });

  it('ignores stale completion after the runtime generation is invalidated', async () => {
    let finish!: (value: ExecResult) => void;
    const runtime = runtimeWithExec(() => new Promise<ExecResult>((resolve) => { finish = resolve; }));
    const resolver = new TargetFactsResolver({ nonce: () => 'fixed-nonce' });
    const pending = resolver.resolve(runtime);

    runtime.invalidate();
    finish({ stdout: encodeTargetFactsFrame('fixed-nonce', facts), stderr: '' });

    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'generation-invalidated' });
  });

  it('cancels only one caller wait without cancelling the shared probe', async () => {
    let finish!: (value: ExecResult) => void;
    const exec = vi.fn(() => new Promise<ExecResult>((resolve) => { finish = resolve; }));
    const runtime = runtimeWithExec(exec);
    const resolver = new TargetFactsResolver({ nonce: () => 'fixed-nonce' });
    const controller = new AbortController();
    const cancelledWait = resolver.resolve(runtime, controller.signal);
    const sharedWait = resolver.resolve(runtime);

    controller.abort();
    await expect(cancelledWait).rejects.toMatchObject({ name: 'AbortError' });
    finish({ stdout: encodeTargetFactsFrame('fixed-nonce', facts), stderr: '' });
    await expect(sharedWait).resolves.toEqual({ ok: true, facts });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
