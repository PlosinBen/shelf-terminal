import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * User-initiated worktree create (the #entry pivot) — sidebar "New Worktree" →
 * WorktreeDialog with a feature-note picker. Proves: the picker lists only
 * in-progress notes; creating with a note migrates it into the worktree and
 * auto-connects; creating with "No note" leaves the base note untouched.
 *
 * A real temp git repo backs the base project so worktreeAdd cuts a real
 * worktree; the note-picker + migrate + auto-connect wiring is what this proves.
 */

const PROJECT_ID = 'wt-base-project';
const BASE_BRANCH = 'main';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wtm-repo-'));
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'e2e',
        GIT_AUTHOR_EMAIL: 'e2e@example.com',
        GIT_COMMITTER_NAME: 'e2e',
        GIT_COMMITTER_EMAIL: 'e2e@example.com',
      },
    });
  git(['init', '-b', BASE_BRANCH]);
  git(['commit', '--allow-empty', '-m', 'init']);
  return repo;
}

function seedNote(repo: string, rel: string, frontmatter: string) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, frontmatter, 'utf-8');
}

function seedProject(userDataDir: string, repo: string) {
  const project = {
    id: PROJECT_ID,
    name: 'WT Base',
    cwd: repo,
    connection: { type: 'local' },
    maxTabs: 5,
  };
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([project]), 'utf-8');
}

async function openNewWorktreeDialog(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'New Worktree' }).click();
  const dialog = page.locator('.worktree-dialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  return dialog;
}

test.describe('user-initiated worktree create', () => {
  let userDataDir: string;
  let repo: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wtm-e2e-'));
    repo = makeRepo();
    // Two notes of different status — BOTH must be pickable (status is shown, not
    // filtered): one in-progress + one cancelled.
    seedNote(repo, '.agent/features/demo.md', '---\ntype: feature\ntitle: Demo Feature\nstatus: in-progress\n---\n\n# Demo\n');
    seedNote(repo, '.agent/features/old.md', '---\ntype: feature\ntitle: Old Feature\nstatus: cancelled\n---\n');
    seedProject(userDataDir, repo);
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 10_000 });
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    const parent = path.dirname(repo);
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(path.basename(repo))) {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      }
    }
  });

  test('picker lists all notes with status; selecting one migrates it and auto-connects', async () => {
    const dialog = await openNewWorktreeDialog(page);

    await expect(dialog.locator('.worktree-target')).toHaveText('WT Base @ main');
    await expect(dialog.locator('.worktree-note-picker').filter({ hasText: 'Agent provider' }).locator('select'))
      .toHaveValue('claude');

    // Every note is pickable regardless of status; each shows its name + status.
    const select = dialog.getByLabel('Feature note');
    const options = select.locator('option');
    await expect(options).toHaveCount(3); // "No note" + Demo (in-progress) + Old (cancelled)
    await expect(select).toContainText('Demo Feature');
    await expect(select).toContainText('in-progress');
    await expect(select).toContainText('Old Feature');
    await expect(select).toContainText('cancelled');

    // Multiple notes → nothing pre-selected; pick the one to seed the worktree.
    await select.selectOption('.agent/features/demo.md');
    await dialog.locator('.worktree-input').fill('feature/m');
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // Worktree child appears under the parent, labelled by branch.
    const items = page.locator('.sidebar-item');
    await expect(items.nth(1)).toHaveClass(/worktree-child/, { timeout: 8_000 });
    await expect(items.nth(1)).toContainText('feature/m');

    // Note migrated: now in the worktree, gone from the base (copy-then-delete).
    expect(fs.existsSync(path.join(`${repo}-feature-m`, '.agent/features/demo.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.agent/features/demo.md'))).toBe(false);

    // Auto-connected: no lingering connect prompt for the now-active worktree.
    await expect(page.locator('.connect-prompt')).toHaveCount(0, { timeout: 8_000 });
  });

  test('choosing "No note" leaves the base note untouched', async () => {
    const dialog = await openNewWorktreeDialog(page);

    await dialog.getByLabel('Feature note').selectOption(''); // "No note"
    await dialog.locator('.worktree-input').fill('feature/n');
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature/n' })).toHaveCount(1, { timeout: 8_000 });
    // Nothing migrated — the base note stays put.
    expect(fs.existsSync(path.join(repo, '.agent/features/demo.md'))).toBe(true);
    expect(fs.existsSync(path.join(`${repo}-feature-n`, '.agent/features/demo.md'))).toBe(false);
  });

  test('agent proposal pre-fills the dialog but still requires the user to Create', async () => {
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
    const textarea = page.locator('.agent-textarea:visible');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('worktree_create:feature/proposed .agent/features/demo.md');
    await textarea.press('Enter');

    const dialog = page.locator('.worktree-dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.locator('.worktree-input')).toHaveValue('feature/proposed');
    await expect(dialog.getByLabel('Feature note')).toHaveValue('.agent/features/demo.md');
    await expect(page.locator('.sidebar-item.worktree-child')).toHaveCount(0);
  });
});
