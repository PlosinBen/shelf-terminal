import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * WSL self-contained-deploy E2E fixture — the WSL counterpart of
 * `makeShelfAppFixture` (which targets a docker container). Kept separate so the
 * docker fixture stays untouched and this can run STANDALONE on a Windows host
 * (the only place `wsl.exe` exists). Unlike the docker specs there is NO
 * container to start: it targets a WSL distro already installed on the host.
 *
 * - SHELF_TEST_MODE=1 → fake provider, so the agent turn round-trips without
 *   real Claude auth while the full deploy still runs end to end.
 * - NODE_ENV=test → keeps the Electron window hidden (set here, not via an npm
 *   script env prefix, so the spec is shell-independent on Windows).
 * - SHELF_RUNTIME_CACHE_DIR → persistent so node/claude downloads are reused.
 *
 * Distro is configurable via SHELF_WSL_TEST_DISTRO (default 'Ubuntu', a glibc
 * distro that exercises the "ship our own node" path).
 */
export const WSL_TEST_DISTRO = process.env.SHELF_WSL_TEST_DISTRO || 'Ubuntu';

export function makeWslShelfAppFixture(distro: string = WSL_TEST_DISTRO) {
  return base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
    shelfApp: [async ({}, use) => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-agentdeploy-wsl-'));
      const runtimeCacheDir = path.join(os.tmpdir(), 'shelf-rt-cache-e2e');
      fs.mkdirSync(runtimeCacheDir, { recursive: true });

      const project = {
        id: 'agent-deploy-wsl-test',
        name: 'Agent Deploy WSL Test',
        cwd: '/tmp',
        connection: { type: 'wsl', distro },
        maxTabs: 4,
      };
      fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([project]), 'utf-8');

      const app = await electron.launch({
        args: [path.join(__dirname, '../..'), `--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          SHELF_TEST_MODE: '1',
          NODE_ENV: 'test',
          SHELF_RUNTIME_CACHE_DIR: runtimeCacheDir,
        },
      });

      let page: Page;
      try {
        page = await app.firstWindow();
        await page.waitForSelector('.app', { timeout: 10_000 });
      } catch (err) {
        await app.close().catch(() => {});
        fs.rmSync(userDataDir, { recursive: true, force: true });
        throw err;
      }

      await use({ app, page });
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }, { scope: 'worker' }],
  });
}

/**
 * Run a command in the distro. Array form (execFileSync), NOT a shell string —
 * the host shell on Windows is cmd.exe, which does not understand the POSIX
 * single-quote wrapping; the argv array bypasses host-shell parsing entirely
 * (same reason wslOps does this in src/main/agent/remote.ts).
 */
function wsl(distro: string, cmd: string): string {
  return execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', cmd], { encoding: 'utf8', stdio: 'pipe' });
}

/** True if the distro has `node` on PATH. */
export function wslHasNode(distro: string = WSL_TEST_DISTRO): boolean {
  try {
    wsl(distro, 'command -v node');
    return true;
  } catch {
    return false;
  }
}

/**
 * List files in the distro's deploy root (empty array if none). Uses $HOME (an
 * absolute home), mirroring wslOps' base — `~` would not expand here.
 */
export function wslDeployedFiles(distro: string = WSL_TEST_DISTRO): string[] {
  try {
    const out = wsl(distro, 'ls "$HOME"/.shelf/agent-server/*/ 2>/dev/null');
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
