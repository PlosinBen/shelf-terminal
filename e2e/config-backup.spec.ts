import { test, expect } from './helpers';
import fs from 'fs';
import path from 'path';
import simpleGit from 'simple-git';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('backup operation panel opens from the footer and resets to Back up after close', async ({ shelfApp: { page } }) => {
  const toggle = page.locator('.right-tab-btn[title="Backup"]');
  await expect(toggle).toBeVisible();

  await toggle.click();
  const panel = page.locator('.backup-view');
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveClass(/active/);

  const backupTab = panel.getByRole('tab', { name: 'Back up' });
  const importTab = panel.getByRole('tab', { name: 'Import' });
  await expect(backupTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.backup-config-form')).toBeVisible();

  await importTab.click();
  await expect(importTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Import Skills and MCP servers from a backup.')).toBeVisible();

  await panel.getByRole('button', { name: 'Close Backup' }).click();
  await expect(panel).toBeHidden();
  await expect(toggle).not.toHaveClass(/active/);

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(backupTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.backup-config-form')).toBeVisible();
});

test('Settings no longer exposes a Backup tab', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const settings = page.locator('.settings-panel');
  await expect(settings).toBeVisible();
  await expect(settings.locator('.settings-tab', { hasText: 'Backup' })).toHaveCount(0);
});

test('Back up config saves, cancels edits, and clears through its single form', async ({ shelfApp }) => {
  const { page, userDataDir } = shelfApp;
  const bindingPath = path.join(userDataDir, 'config-backup.json');

  await page.locator('.right-tab-btn[title="Backup"]').click();
  const panel = page.locator('.backup-view');
  const form = panel.locator('.backup-config-form');
  await expect(form).toBeVisible();

  const remoteInput = form.getByLabel('Remote URL');
  const labelInput = form.getByLabel("This machine's label");
  await expect(labelInput).not.toHaveValue('');

  // A label-only partial setting may persist for compatibility, but it remains
  // unconfigured and never enters the ready summary state.
  await labelInput.fill('partial-machine');
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form).toBeVisible();
  await expect(panel.locator('.backup-config-summary')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(bindingPath, 'utf-8'))).toEqual({
    remoteUrl: '',
    machineLabel: 'partial-machine',
  });

  await remoteInput.fill('/tmp/shelf-backup.git');
  await form.getByRole('button', { name: 'Save settings' }).click();
  const summary = panel.locator('.backup-config-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('/tmp/shelf-backup.git');
  expect(JSON.parse(fs.readFileSync(bindingPath, 'utf-8'))).toEqual({
    remoteUrl: '/tmp/shelf-backup.git',
    machineLabel: 'partial-machine',
  });

  // Cancel restores the saved values without touching persistence.
  await summary.getByRole('button', { name: 'Edit' }).click();
  await form.getByLabel('Remote URL').fill('/tmp/unsaved.git');
  await form.getByLabel("This machine's label").fill('unsaved-machine');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(summary).toContainText('/tmp/shelf-backup.git');
  await expect(summary).toContainText('partial-machine');
  expect(JSON.parse(fs.readFileSync(bindingPath, 'utf-8'))).toEqual({
    remoteUrl: '/tmp/shelf-backup.git',
    machineLabel: 'partial-machine',
  });

  // Clear uses the same Save boundary; there is no independent Unbind action.
  await summary.getByRole('button', { name: 'Edit' }).click();
  await form.getByLabel('Remote URL').fill('');
  await form.getByLabel("This machine's label").fill('');
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form).toBeVisible();
  expect(fs.existsSync(bindingPath)).toBe(false);
});

test('Back up preselects intent, blocks invalid Skills, and preserves unselected remote items', async ({ shelfApp }) => {
  const { page, userDataDir } = shelfApp;
  const remote = path.join(userDataDir, 'backup-remote.git');
  await simpleGit().raw(['init', '--bare', remote]);

  const seedSkill = (name: string, declaredName = name) => {
    const directory = path.join(userDataDir, 'skills', 'skills', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${declaredName}\ndescription: ${name} description\n---\n# ${name}\n`,
    );
    return directory;
  };
  const alpha = seedSkill('alpha');
  const beta = seedSkill('beta');
  seedSkill('broken', 'different-name');
  fs.writeFileSync(path.join(alpha, 'version.txt'), 'alpha-one');
  fs.writeFileSync(path.join(alpha, '.locked'), '');
  fs.writeFileSync(path.join(alpha, '.disabled'), '');
  fs.writeFileSync(path.join(beta, 'version.txt'), 'beta-one');
  fs.writeFileSync(
    path.join(userDataDir, 'mcp-servers.json'),
    JSON.stringify({ fs: { type: 'stdio', command: 'node' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(userDataDir, 'config-backup.json'),
    JSON.stringify({ remoteUrl: remote, machineLabel: 'e2e-machine' }, null, 2),
  );
  fs.writeFileSync(
    path.join(userDataDir, 'config-backup-intent.json'),
    JSON.stringify(['skill:alpha', 'skill:broken'], null, 2),
  );

  await page.locator('.right-tab-btn[title="Backup"]').click();
  const panel = page.locator('.backup-view');
  const selection = panel.locator('.backup-selection');
  await expect(selection).toContainText('Skills');
  await expect(selection).toContainText('1 selected · 1 new not selected');
  await expect(selection).toContainText('MCP servers');
  await expect(selection).toContainText('0 selected · 1 new not selected');
  await expect(selection.locator('.backup-selection-groups')).toHaveCount(0);

  await selection.getByRole('button', { name: 'Change selection' }).click();
  const alphaCheck = selection.locator('.backup-check', { hasText: 'alpha' }).locator('input');
  const betaCheck = selection.locator('.backup-check', { hasText: 'beta' }).locator('input');
  const brokenRow = selection.locator('.backup-check', { hasText: 'broken' });
  await expect(alphaCheck).toBeChecked();
  await expect(betaCheck).not.toBeChecked();
  await expect(brokenRow.locator('input')).toBeDisabled();
  await expect(brokenRow).toContainText('Invalid');
  await expect(brokenRow).toContainText('does not match folder');

  await panel.getByRole('button', { name: 'Back up now' }).click();
  await expect(panel.locator('.backup-status-ok')).toHaveText('Backed up 1 item.');

  const appInstanceId = fs.readFileSync(path.join(userDataDir, 'app-instance-id'), 'utf-8').trim();
  const branch = `refs/heads/backup/${appInstanceId}`;
  const git = simpleGit();
  const listFiles = async () => (await git.raw([
    '--git-dir', remote,
    'ls-tree', '-r', '--name-only', branch,
  ])).trim().split('\n').filter(Boolean);
  const firstFiles = await listFiles();
  expect(firstFiles).toEqual(expect.arrayContaining([
    'machine.json',
    'skills/alpha/SKILL.md',
    'skills/alpha/version.txt',
  ]));
  expect(firstFiles).not.toContain('skills/alpha/.locked');
  expect(firstFiles).not.toContain('skills/alpha/.disabled');
  expect(firstFiles).not.toContain('skills/beta/SKILL.md');

  await selection.getByRole('button', { name: 'Change selection' }).click();
  await alphaCheck.uncheck();
  await betaCheck.check();
  fs.writeFileSync(path.join(alpha, 'version.txt'), 'alpha-two-not-selected');
  await panel.getByRole('button', { name: 'Back up now' }).click();
  await expect(panel.locator('.backup-status-ok')).toHaveText('Backed up 1 item.');

  expect(await git.raw(['--git-dir', remote, 'show', `${branch}:skills/alpha/version.txt`])).toBe('alpha-one');
  expect(await git.raw(['--git-dir', remote, 'show', `${branch}:skills/beta/version.txt`])).toBe('beta-one');
  expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'config-backup-intent.json'), 'utf-8')))
    .toEqual(['skill:beta']);

  await panel.getByRole('button', { name: 'Close Backup' }).click();
  await page.locator('.right-tab-btn[title="Backup"]').click();
  await selection.getByRole('button', { name: 'Change selection' }).click();
  await expect(alphaCheck).not.toBeChecked();
  await expect(betaCheck).toBeChecked();
  await expect(brokenRow.locator('input')).toBeDisabled();
});
