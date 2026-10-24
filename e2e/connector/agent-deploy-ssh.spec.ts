import { test, expect, _electron as electron } from '@playwright/test';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sendAgentPrompt } from '../helpers';

const run = promisify(execFile);
const IMAGE = 'shelf-ssh-agent-deploy-test';
const USER = 'testuser';
const PASSWORD = 'testpass';
let container: string;

test.skip(process.platform === 'win32', 'Password-only reuse requires Unix ControlMaster');
test.setTimeout(180_000);
test.beforeAll(async () => {
  await run('docker', ['build', '-t', IMAGE, path.join(__dirname, 'ssh-deploy')], { timeout: 240_000 });
});

for (const mode of ['dispatcher', 'direct'] as const) {
  test(`${mode}: password-only project connects and deploys an agent without a terminal`, async ({}, testInfo) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sshdeploy-'));
    container = `shelf-sshdeploy-${crypto.randomUUID()}`;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await run('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::22', IMAGE]);
      const { stdout } = await run('docker', ['port', container, '22/tcp']);
      const port = Number(stdout.trim().split(':').pop());
      await expect.poll(async () => {
        const result = await run('docker', ['logs', container]);
        return result.stderr;
      }, { timeout: 20_000 }).toContain('Server listening');

      // Promise: this regression proves password-only auth through project connect,
      // not accidental use of the runner's keys, ssh config, or an existing master.
      // Review connector auth policy and both agent startup paths before weakening it.
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      // Shell-env priming must preserve the isolated PATH instead of loading
      // the runner's login profile and putting its SSH client ahead of ours.
      const shell = path.join(bin, 'test-shell');
      fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-ilc" ] && [ "$2" = "env" ]; then exec /usr/bin/env; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
      const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const trace = path.join(dir, 'ssh-argv.log');
      for (const command of ['ssh', 'scp']) {
        fs.writeFileSync(path.join(bin, command),
          `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(trace)}\nexec /usr/bin/${command} -F /dev/null -o IdentityAgent=none -o PubkeyAuthentication=no -o GlobalKnownHostsFile=/dev/null "$@"\n`,
          { mode: 0o755 });
      }
      fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([{
        id: 'ssh-agent-deploy', name: 'SSH Agent Deploy', cwd: '/tmp', maxTabs: 4,
        connection: { type: 'ssh', host: '127.0.0.1', port, user: USER, password: PASSWORD },
      }]));
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', SHELF_TEST_MODE: '1', SHELL: shell,
        SHELF_USE_DISPATCHER: mode === 'direct' ? '0' : '1',
        SHELF_RUNTIME_CACHE_DIR: path.join(os.tmpdir(), 'shelf-rt-cache-e2e'),
        PATH: `${bin}${path.delimiter}${process.env.PATH}` };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.SSH_AUTH_SOCK;
      app = await electron.launch({ args: [path.join(__dirname, '../..'), `--user-data-dir=${dir}`], env, timeout: 20_000 });
      const page = await app.firstWindow();
      await page.waitForSelector('.app');
      await page.evaluate(async () => {
        const project = (await window.shelfApi.project.getAll())[0];
        await window.shelfApi.project.update({ ...project,
          defaultTabs: [{ kind: 'agent', name: 'Agent', provider: 'claude' }] });
      });
      await page.reload();
      await page.waitForSelector('.app');
      await page.locator('.connect-prompt').click();
      // A tab is created only after CONNECT_PROJECT's connector.connect resolves.
      await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 20_000 });
      await expect(page.locator('.agent-view')).toHaveCount(1);
      await expect(page.locator('.terminal-container')).toHaveCount(0);
      await expect(page.locator('.agent-empty, .agent-conn-reason')).toBeVisible({ timeout: 120_000 });
      await expect(page.locator('.agent-conn-reason')).toHaveCount(0);
      await sendAgentPrompt(page, 'picker_single');
      await expect(page.locator('.picker-panel:visible')).toBeVisible({ timeout: 120_000 });
      await expect(page.locator('.picker-option')).toHaveCount(3);
      await expect(page.locator('.terminal-container')).toHaveCount(0);
    } finally {
      if (app) await app.close();
      const trace = path.join(dir, 'ssh-argv.log');
      if (fs.existsSync(trace)) await testInfo.attach('ssh-argv', { path: trace, contentType: 'text/plain' });
      const logs = path.join(dir, 'logs');
      if (fs.existsSync(logs)) for (const file of fs.readdirSync(logs, { recursive: true })) {
        const logPath = path.join(logs, String(file));
        if (fs.statSync(logPath).isFile()) await testInfo.attach(`main-${file}`, { path: logPath, contentType: 'text/plain' });
      }
      await run('docker', ['rm', '-f', container]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
