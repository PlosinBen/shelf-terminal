import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { resolveCodexCliCommand } from '../codex-shared/runtime';
import { CodexAppServerClient } from './app-server-client';
import { CodexNativeControls } from './native-controls';

it('loads native controls through the pinned app-server request parser without an account or inference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shelf-codex-controls-'));
  const cwd = path.join(root, 'workspace');
  const configHome = path.join(root, 'codex');
  await mkdir(cwd);
  await mkdir(configHome);
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: configHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const { command, args } = resolveCodexCliCommand();
  const child = spawn(command, [...args, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Drain diagnostics without printing environment-specific paths or unrelated warnings.
  child.stderr.resume();
  const exited = once(child, 'exit');
  const client = new CodexAppServerClient({ process: child, requestTimeoutMs: 10_000 });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'shelf_native_controls_test', version: '0' },
      capabilities: { experimentalApi: true },
    });
    const controls = new CodexNativeControls();
    await controls.load(client, cwd, []);
    const control = controls.capabilities().permissionControl;
    expect(control.strategy).toBe('native');
    if (control.strategy !== 'native') throw new Error('Expected native controls');
    expect(control.mode?.options.length).toBeGreaterThan(0);
    expect(control.permission?.options.length).toBeGreaterThan(0);
    expect(control.approval?.options.length).toBeGreaterThan(0);
  } finally {
    client.close();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
