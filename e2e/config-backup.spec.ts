import { test, expect } from './helpers';
import fs from 'fs';
import path from 'path';
import simpleGit from 'simple-git';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function pushBackupBranch(
  remote: string,
  workingDirectory: string,
  branch: string,
  files: Record<string, string>,
): Promise<void> {
  await simpleGit().clone(remote, workingDirectory);
  const git = simpleGit(workingDirectory);
  await git.addConfig('user.name', 'Backup E2E');
  await git.addConfig('user.email', 'backup-e2e@shelf.local');
  await git.checkout(['-b', branch]);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(workingDirectory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  await git.add(['-A']);
  await git.commit('seed backup source');
  await git.push(['-u', 'origin', branch]);
}

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
  await expect(panel.getByRole('heading', { name: 'Import into this machine' })).toBeVisible();

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

test('Import discovers pinned sources from an unsaved URL and labels selectable impact', async ({ shelfApp }) => {
  const { page, userDataDir } = shelfApp;
  const remote = path.join(userDataDir, 'import-remote.git');
  await simpleGit().raw(['init', '--bare', remote]);

  const appInstanceFile = path.join(userDataDir, 'app-instance-id');
  if (!fs.existsSync(appInstanceFile)) fs.writeFileSync(appInstanceFile, 'e2e-self-id\n');
  const appInstanceId = fs.readFileSync(appInstanceFile, 'utf-8').trim();

  const localAlpha = path.join(userDataDir, 'skills', 'skills', 'alpha');
  fs.mkdirSync(localAlpha, { recursive: true });
  fs.writeFileSync(
    path.join(localAlpha, 'SKILL.md'),
    '---\nname: alpha\ndescription: local alpha\n---\n',
  );

  await pushBackupBranch(
    remote,
    path.join(userDataDir, 'seed-source'),
    'backup/source-id',
    {
      'machine.json': JSON.stringify({ appInstanceId: 'source-id', machineLabel: 'source-machine' }),
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: remote alpha\n---\n',
      'skills/beta/SKILL.md': '---\nname: beta\ndescription: remote beta\n---\n',
      'skills/broken/SKILL.md': '---\nname: wrong-name\n---\n',
      'mcp-servers.json': '{broken',
    },
  );
  await pushBackupBranch(
    remote,
    path.join(userDataDir, 'seed-self'),
    `backup/${appInstanceId}`,
    {
      'machine.json': JSON.stringify({ appInstanceId, machineLabel: 'self-machine' }),
      'skills/self-restore/SKILL.md': '---\nname: self-restore\ndescription: restore me\n---\n',
    },
  );

  expect(fs.existsSync(path.join(userDataDir, 'config-backup.json'))).toBe(false);
  await page.locator('.right-tab-btn[title="Backup"]').click();
  const panel = page.locator('.backup-view');
  await panel.getByRole('tab', { name: 'Import' }).click();
  const remoteInput = panel.getByLabel('Remote URL');
  await expect(remoteInput).toHaveValue('');
  await remoteInput.fill(remote);
  await panel.getByRole('button', { name: 'Find backups' }).click();

  const sourcePicker = panel.getByLabel('Backup source');
  await expect(sourcePicker.locator('option')).toContainText([
    'Choose a backup…',
    'self-machine (this machine)',
    'source-machine',
  ]);
  await sourcePicker.selectOption({ label: 'source-machine' });

  const selection = panel.locator('.import-item-selection');
  // Materializing the pinned Git commit can exceed Playwright's 5s default on
  // a cold filesystem; wait for the completed import surface explicitly.
  await expect(selection).toBeVisible({ timeout: 15_000 });
  const alpha = selection.locator('.backup-check', { hasText: 'alpha' });
  const beta = selection.locator('.backup-check', { hasText: 'beta' });
  const broken = selection.locator('.backup-check', { hasText: 'broken' });
  await expect(alpha).toContainText('Replace local');
  await expect(beta).toContainText('New');
  await expect(alpha.locator('input')).not.toBeChecked();
  await expect(beta.locator('input')).not.toBeChecked();
  await expect(broken.locator('input')).toBeDisabled();
  await expect(broken).toContainText('does not match folder');
  await expect(selection.locator('.import-category-issue')).toContainText(
    'mcp-servers.json is not a keyed JSON object',
  );

  await selection.getByRole('button', { name: 'Select all' }).click();
  await expect(alpha.locator('input')).toBeChecked();
  await expect(beta.locator('input')).toBeChecked();
  await expect(broken.locator('input')).toBeDisabled();
  await expect(selection.locator('.import-selection-count')).toHaveText('2 selected');

  await remoteInput.fill(`${remote}-edited`);
  await expect(panel.locator('.import-source-field')).toHaveCount(0);
  await expect(panel.locator('.import-item-selection')).toHaveCount(0);
});

test('Import replaces selected whole items, refreshes impact, and preserves failed selection', async ({ shelfApp }) => {
  const { page, userDataDir } = shelfApp;
  const remote = path.join(userDataDir, 'apply-import-remote.git');
  await simpleGit().raw(['init', '--bare', remote]);

  const seedLocalSkill = (name: string, description: string) => {
    const directory = path.join(userDataDir, 'skills', 'skills', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n`,
    );
    return directory;
  };
  const shared = seedLocalSkill('shared', 'local shared');
  fs.writeFileSync(path.join(shared, 'old-only.txt'), 'remove me');
  fs.writeFileSync(path.join(shared, '.locked'), '');
  fs.writeFileSync(path.join(shared, '.disabled'), '');
  seedLocalSkill('unrelated', 'leave local');
  const mcpFile = path.join(userDataDir, 'mcp-servers.json');
  fs.writeFileSync(mcpFile, JSON.stringify({
    existing: { type: 'stdio', command: 'old' },
    untouched: { type: 'http', url: 'https://local.example' },
  }, null, 2));

  await pushBackupBranch(
    remote,
    path.join(userDataDir, 'seed-apply-source'),
    'backup/apply-source',
    {
      'machine.json': JSON.stringify({ appInstanceId: 'apply-source', machineLabel: 'apply-source' }),
      'skills/shared/SKILL.md': '---\nname: shared\ndescription: source shared\n---\n',
      'skills/shared/new-only.txt': 'source file',
      'skills/shared/.locked': 'source marker ignored',
      'skills/beta/SKILL.md': '---\nname: beta\ndescription: source beta\n---\n',
      'skills/beta/.disabled': 'source marker ignored',
      'mcp-servers.json': JSON.stringify({
        existing: { type: 'stdio', command: 'new' },
        'remote-extra': { type: 'stdio', command: 'extra' },
      }),
    },
  );

  await page.locator('.right-tab-btn[title="Backup"]').click();
  const panel = page.locator('.backup-view');
  await panel.getByRole('tab', { name: 'Import' }).click();
  await panel.getByLabel('Remote URL').fill(remote);
  await panel.getByRole('button', { name: 'Find backups' }).click();
  await panel.getByLabel('Backup source').selectOption({ label: 'apply-source' });

  const selection = panel.locator('.import-item-selection');
  const row = (name: string) => selection.locator('.backup-check', { hasText: name });
  await row('shared').locator('input').check();
  await row('beta').locator('input').check();
  await row('existing').locator('input').check();
  await panel.getByRole('button', { name: 'Import 3 items' }).click();
  await expect(panel.locator('.backup-status-ok')).toHaveText('Imported 3 items; 3 changed.');

  await expect(selection.locator('.import-selection-count')).toHaveText('0 selected');
  await expect(row('shared').locator('input')).not.toBeChecked();
  await expect(row('beta')).toContainText('Replace local');
  expect(fs.readFileSync(path.join(shared, 'new-only.txt'), 'utf-8')).toBe('source file');
  expect(fs.existsSync(path.join(shared, 'old-only.txt'))).toBe(false);
  expect(fs.existsSync(path.join(shared, '.locked'))).toBe(true);
  expect(fs.existsSync(path.join(shared, '.disabled'))).toBe(true);
  const beta = path.join(userDataDir, 'skills', 'skills', 'beta');
  expect(fs.existsSync(path.join(beta, '.locked'))).toBe(false);
  expect(fs.existsSync(path.join(beta, '.disabled'))).toBe(false);
  expect(fs.readFileSync(path.join(userDataDir, 'skills', 'skills', 'unrelated', 'SKILL.md'), 'utf-8'))
    .toContain('leave local');
  expect(JSON.parse(fs.readFileSync(mcpFile, 'utf-8'))).toEqual({
    existing: { type: 'stdio', command: 'new' },
    untouched: { type: 'http', url: 'https://local.example' },
  });

  await row('remote-extra').locator('input').check();
  fs.writeFileSync(mcpFile, '{broken local json');
  await panel.getByRole('button', { name: 'Import 1 item' }).click();
  const failure = panel.locator('.import-failure');
  await expect(failure).toContainText('Validation failed');
  await expect(failure).toContainText('Item: mcp:remote-extra');
  await expect(failure).toContainText('Rollback: Not needed');
  await expect(row('remote-extra').locator('input')).toBeChecked();
});
