import { test, expect } from './helpers';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

// Settings → Backup tab: the full UI → IPC → git wire for the Backup half.
// A temp BARE repo stands in for the GitHub remote (local path, real git). We
// bind, tick a seeded skill, back up, and assert the remote branch got exactly
// that skill + the machine manifest. Main-process logic is covered by
// src/main/config-backup/*.test.ts; this proves the renderer wire.

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('config backup: bind remote, tick a skill, back up to my branch', async ({ shelfApp }) => {
  const { page, userDataDir } = shelfApp;

  // A local bare repo as the "remote".
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-backup-remote-'));
  const bare = path.join(remoteDir, 'backups.git');
  execFileSync('git', ['init', '--bare', bare]);

  // Seed a live skill — listSkills() reads live, so post-launch is fine.
  const skillDir = path.join(userDataDir, 'skills', 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo\ndescription: demo skill\n---\n# demo\n',
    'utf-8',
  );

  // Open Settings → Backup.
  await page.keyboard.press(`${modifier}+,`);
  await expect(page.locator('.settings-panel')).toBeVisible({ timeout: 3_000 });
  await page.locator('.settings-tab', { hasText: 'Backup' }).click();

  // Bind form → fill remote + label → Bind.
  const inputs = page.locator('.backup-input');
  await expect(inputs).toHaveCount(2);
  await inputs.nth(0).fill(bare);
  await inputs.nth(1).fill('e2e-machine');
  await page.locator('.conn-btn-next', { hasText: 'Bind remote' }).click();

  // Checklist appears with the demo skill (unticked — it's new/never-backed-up).
  const demoRow = page.locator('.backup-check', { hasText: 'demo' });
  await expect(demoRow).toBeVisible({ timeout: 15_000 });
  const demoCheck = demoRow.locator('input[type=checkbox]');
  await expect(demoCheck).not.toBeChecked();

  // Tick it and back up.
  await demoCheck.check();
  await page.locator('.conn-btn-next', { hasText: 'Back up' }).click();
  await expect(page.locator('.backup-status-ok')).toContainText(/Backed up/i, { timeout: 20_000 });

  // The remote branch now holds exactly that skill + the machine manifest.
  const branch = execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .toString()
    .trim()
    .split('\n')
    .find((b) => b.startsWith('backup/'));
  expect(branch).toBeTruthy();
  const files = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', branch!]).toString();
  expect(files).toContain('skills/demo/SKILL.md');
  expect(files).toContain('machine.json');

  fs.rmSync(remoteDir, { recursive: true, force: true });
});
