import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { CLAUDE_PROVIDER } from '../src/shared/agent-providers';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { openAgentTab } from './helpers';
import { IPC } from '../src/shared/ipc-channels';

/**
 * User-initiated worktree create (the #entry pivot) — sidebar "New Worktree" →
 * WorktreeDialog with a feature-note picker. Proves: the picker lists configured
 * notes with their statuses; creating with a note migrates it into the worktree and
 * auto-connects; creating with "No note" leaves the base note untouched.
 *
 * A real temp git repo backs the base project so worktreeAdd cuts a real
 * worktree; the note-picker + migrate + auto-connect wiring is what this proves.
 * These assertions protect the user-visible cross-process handoff rather than
 * dialog implementation details. If they change, review the Worktree dialog,
 * proposal-tool contract, child-config boundary, and durable worktree context.
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

function seedProject(
  userDataDir: string,
  repo: string,
  featureNoteDir?: string,
  includeDistractor = false,
) {
  const project = {
    id: PROJECT_ID,
    name: 'WT Base',
    cwd: repo,
    connection: { type: 'local' },
    maxTabs: 5,
    defaultAgentProvider: CLAUDE_PROVIDER,
    featureNoteDir,
  };
  const projects = includeDistractor
    ? [project, {
        id: 'other-project',
        name: 'Other Project',
        cwd: path.dirname(repo),
        connection: { type: 'local' },
        maxTabs: 5,
      }]
    : [project];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

async function openNewWorktreeDialog(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'New Worktree' }).click();
  const dialog = page.locator('.worktree-dialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  return dialog;
}

function readLogText(userDataDir: string): string {
  const root = path.join(userDataDir, 'logs');
  if (!fs.existsSync(root)) return '';
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(abs);
    }
  };
  walk(root);
  return files.map((file) => fs.readFileSync(file, 'utf-8')).join('\n');
}

test.describe('user-initiated worktree create', () => {
  test.describe.configure({ timeout: 60_000 });

  let userDataDir: string;
  let repo: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async ({}, testInfo) => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wtm-e2e-'));
    repo = makeRepo();
    // Two notes of different status — BOTH must be pickable (status is shown, not
    // filtered): one in-progress + one cancelled.
    seedNote(repo, '.agent/features/demo.md', '---\ntype: feature\ntitle: Demo Feature\nstatus: in-progress\n---\n\n# Demo\n');
    seedNote(repo, '.agent/features/old.md', '---\ntype: feature\ntitle: Old Feature\nstatus: cancelled\n---\n');
    const title = testInfo.titlePath.join(' ');
    const featureNoteDir = title.includes('without configured directory')
      ? undefined
      : title.includes('empty configured directory')
        ? 'notes/features'
        : title.includes('unlistable configured directory')
          ? 'outside-notes'
        : '.agent/features';
    if (title.includes('unlistable configured directory')) {
      fs.symlinkSync(os.tmpdir(), path.join(repo, 'outside-notes'));
    }
    seedProject(userDataDir, repo, featureNoteDir, title.includes('agent proposal'));
    const forceCreateFailure = testInfo.titlePath.join(' ').includes('migration rollback failure');
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        SHELF_TEST_MODE: '1',
        NODE_ENV: 'test',
        ...(forceCreateFailure
          ? {
              SHELF_TEST_GIT_MIGRATE_NOTE_ERROR: 'FULL MIGRATION ERROR\ncopy failed: demo.md',
              SHELF_TEST_GIT_WORKTREE_REMOVE_ERROR: 'FULL ROLLBACK ERROR\nworktree busy',
              LOG_LEVEL: 'info',
            }
          : {}),
      } as Record<string, string>,
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

    await expect(dialog).toHaveCSS('width', '600px');
    await expect(dialog.locator('.worktree-target')).toHaveText('WT Base @ main');
    await expect(dialog.locator('.worktree-note-picker-label', { hasText: 'Feature note' }))
      .toContainText('.agent/features');
    await expect(dialog.locator('.worktree-note-picker').filter({ hasText: 'Agent provider' }).locator('select'))
      .toHaveValue(CLAUDE_PROVIDER);

    // Every note is pickable regardless of status; rows are filename-first and
    // keep status on the same line as the filename.
    const rows = dialog.locator('.worktree-note-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.worktree-note-filename')).toHaveText('demo.md');
    await expect(rows.nth(0).locator('.worktree-note-title')).toHaveText('Demo Feature');
    await expect(rows.nth(0).locator('.worktree-note-heading .worktree-note-status')).toHaveText('in-progress');
    await expect(rows.nth(1).locator('.worktree-note-filename')).toHaveText('old.md');
    await expect(rows.nth(1).locator('.worktree-note-title')).toHaveText('Old Feature');
    await expect(rows.nth(1).locator('.worktree-note-heading .worktree-note-status')).toHaveText('cancelled');

    // Multiple notes → nothing pre-selected; pick both to seed the worktree.
    await rows.nth(0).locator('input[type="checkbox"]').check();
    await rows.nth(1).locator('input[type="checkbox"]').check();
    await dialog.locator('.worktree-input').fill('feature/m');
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });

    // Worktree child appears under the parent, labelled by branch.
    const items = page.locator('.sidebar-item');
    await expect(items.nth(1)).toHaveClass(/worktree-child/, { timeout: 8_000 });
    await expect(items.nth(1)).toContainText('feature/m');

    const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8')) as {
      schemaVersion: number;
      projects: Array<{ parentProjectId?: string; featureNoteDir?: string }>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.projects.find((project) => project.parentProjectId === PROJECT_ID)?.featureNoteDir)
      .toBe('.agent/features');

    await items.nth(1).click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
    const featureDirField = page.locator('.project-edit-field', { hasText: 'Feature Note Directory' });
    await expect(featureDirField.locator('input')).toHaveValue('.agent/features');
    await expect(featureDirField.locator('input')).toBeDisabled();
    await page.locator('.project-edit-panel .settings-close').click();

    // Notes migrated: now in the worktree, gone from the base (copy-then-delete).
    expect(fs.existsSync(path.join(`${repo}-feature-m`, '.agent/features/demo.md'))).toBe(true);
    expect(fs.existsSync(path.join(`${repo}-feature-m`, '.agent/features/old.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.agent/features/demo.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.agent/features/old.md'))).toBe(false);

    // Auto-connected: no lingering connect prompt for the now-active worktree.
    await expect(page.locator('.connect-prompt')).toHaveCount(0, { timeout: 8_000 });
  });

  test('without configured directory omits the entire Feature Note section', async () => {
    const dialog = await openNewWorktreeDialog(page);
    await expect(dialog.locator('.worktree-note-picker-label', { hasText: 'Feature note' })).toHaveCount(0);
    await expect(dialog.locator('.worktree-note-row')).toHaveCount(0);
    await expect(dialog.locator('.worktree-note-empty')).toHaveCount(0);
  });

  test('empty configured directory shows its path and a successful empty state', async () => {
    const dialog = await openNewWorktreeDialog(page);
    const label = dialog.locator('.worktree-note-picker-label', { hasText: 'Feature note' });
    await expect(label).toContainText('notes/features');
    await expect(dialog.locator('.worktree-note-row')).toHaveCount(0);
    await expect(dialog.locator('.worktree-note-empty')).toHaveText('No feature notes available');
  });

  test('unlistable configured directory shows the full error without disabling Create', async () => {
    const dialog = await openNewWorktreeDialog(page);
    await expect(dialog.locator('.worktree-note-picker-label', { hasText: 'Feature note' }))
      .toContainText('outside-notes');
    await expect(dialog.locator('.worktree-note-list-error')).toContainText(
      'Configured feature note directory escapes project root',
    );
    await dialog.locator('.worktree-input').fill('feature/no-note');
    await expect(dialog.locator('.conn-btn-next')).toBeEnabled();
  });

  test('choosing "No note" leaves the base note untouched', async () => {
    const dialog = await openNewWorktreeDialog(page);

    await expect(dialog.locator('.worktree-note-row input[type="checkbox"]:checked')).toHaveCount(0);
    await dialog.locator('.worktree-input').fill('feature/n');
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });

    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature/n' })).toHaveCount(1, { timeout: 8_000 });
    // Nothing migrated — the base note stays put.
    expect(fs.existsSync(path.join(repo, '.agent/features/demo.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.agent/features/old.md'))).toBe(true);
    expect(fs.existsSync(path.join(`${repo}-feature-n`, '.agent/features/demo.md'))).toBe(false);
    expect(fs.existsSync(path.join(`${repo}-feature-n`, '.agent/features/old.md'))).toBe(false);
  });

  test('secret copy Retry continues the already committed child once', async () => {
    await app.evaluate(({ dialog, ipcMain }, channel) => {
      let copyAttempts = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        copyAttempts++;
        (globalThis as any).__worktreeSecretCopyAttempts = copyAttempts;
        if (copyAttempts === 1) throw new Error('simulated secret copy failure');
      });
      (globalThis as any).__worktreeSecretCopyPrompts = 0;
      (dialog as any).showMessageBox = async (_window: unknown, options: { title?: string }) => {
        if (options.title === 'Worktree created, but secrets were not copied') {
          (globalThis as any).__worktreeSecretCopyPrompts++;
          return { response: 0, checkboxChecked: false };
        }
        return { response: 1, checkboxChecked: false };
      };
    }, IPC.PROJECT_SECRETS_COPY);
    const dialog = await openNewWorktreeDialog(page);
    await dialog.locator('.worktree-input').fill('feature/secret-retry');
    await dialog.locator('.conn-btn-next').click();

    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature/secret-retry' })).toHaveCount(1);
    await expect(page.locator('.connect-prompt')).toHaveCount(0, { timeout: 8_000 });
    expect(await app.evaluate(() => (globalThis as any).__worktreeSecretCopyAttempts)).toBe(2);
    expect(await app.evaluate(() => (globalThis as any).__worktreeSecretCopyPrompts)).toBe(1);
  });

  test('secret copy Cancel keeps one durable child disconnected', async () => {
    await app.evaluate(({ dialog, ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        (globalThis as any).__worktreeSecretCopyAttempts =
          ((globalThis as any).__worktreeSecretCopyAttempts ?? 0) + 1;
        throw new Error('simulated persistent secret copy failure');
      });
      (dialog as any).showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    }, IPC.PROJECT_SECRETS_COPY);
    const dialog = await openNewWorktreeDialog(page);
    await dialog.locator('.worktree-input').fill('feature/secret-cancel');
    await dialog.locator('.conn-btn-next').click();

    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature/secret-cancel' })).toHaveCount(1);
    await expect(page.locator('.connect-prompt')).toBeVisible();
    expect(await app.evaluate(() => (globalThis as any).__worktreeSecretCopyAttempts)).toBe(1);
    const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf8'));
    expect(document.projects).toHaveLength(2);
  });

  test('agent proposal pre-fills the dialog but still requires the user to Create', async () => {
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
    const textarea = page.locator('.agent-textarea:visible');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('delay:800|worktree_create:feature/proposed demo.md');
    await textarea.press('Enter');

    const baseProject = page.locator('.sidebar-item', { hasText: 'WT Base' });
    const otherProject = page.locator('.sidebar-item', { hasText: 'Other Project' });
    await otherProject.click();
    await expect(otherProject).toHaveClass(/active/);

    const dialog = page.locator('.worktree-dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(baseProject).toHaveClass(/active/);
    await expect(dialog.locator('.project-requester')).toHaveText('Requested by: WT Base');
    await expect(dialog.locator('.worktree-input')).toHaveValue('feature/proposed');
    await expect(
      dialog.locator('.worktree-note-row', { hasText: 'demo.md' }).locator('input[type="checkbox"]'),
    ).toBeChecked();
    await expect(
      dialog.locator('.worktree-note-row', { hasText: 'old.md' }).locator('input[type="checkbox"]'),
    ).not.toBeChecked();
    await dialog.locator('.settings-close').click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    await expect(baseProject).toHaveClass(/active/);

    const auditCard = page
      .locator('.agent-msg-fold:has(.fold-label:has-text("Shelf tool")):visible')
      .last();
    await expect(auditCard).toBeVisible({ timeout: 5_000 });
    await expect(auditCard.locator('.fold-subtitle')).toHaveText('propose_worktree_create');
    await auditCard.locator('.fold-header').click();
    await expect(auditCard.locator('.fold-body-code')).toContainText('"note": "demo.md"');
    await expect(auditCard.locator('.fold-body-code')).toContainText('"notePaths": [');
    await expect(auditCard.locator('.fold-body-code')).toContainText('".agent/features/demo.md"');
    await expect(page.locator('.sidebar-item.worktree-child')).toHaveCount(0);
  });

  test('migration rollback failure reveals full errors, logs them, and sends them to the base agent', async () => {
    await openAgentTab(page);

    const dialog = await openNewWorktreeDialog(page);
    await dialog.locator('.worktree-note-row', { hasText: 'demo.md' }).locator('input[type="checkbox"]').check();
    await dialog.locator('.worktree-input').fill('feature/fail');
    await dialog.locator('.conn-btn-next').click();

    const err = dialog.locator('.worktree-error');
    // This promise spans real worktree creation plus forced migration and
    // rollback failures. Wait for the operation boundary, not an 8s UI timing
    // assumption, while preserving every error-content assertion below.
    await expect(err).toContainText('FULL MIGRATION ERROR', { timeout: 30_000 });
    await expect(err).toContainText('copy failed: demo.md');
    await expect(err).toContainText('Rollback also failed');
    await expect(err).toContainText('FULL ROLLBACK ERROR');
    await expect(err).toContainText('worktree busy');

    await expect.poll(() => readLogText(userDataDir), { timeout: 5_000 }).toContain('worktree-create');
    const logs = readLogText(userDataDir);
    expect(logs).toContain('"failedStep":"migrateNote"');
    expect(logs).toContain('FULL MIGRATION ERROR');
    expect(logs).toContain('"failedStep":"rollbackWorktreeRemove"');
    expect(logs).toContain('FULL ROLLBACK ERROR');

    await err.locator('button', { hasText: 'Send to agent' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    const userMsg = page.locator('.agent-msg-user .agent-msg-content');
    await expect(userMsg.first()).toContainText('worktree create flow failed', { timeout: 8_000 });
    await expect(userMsg.first()).toContainText('Branch: feature/fail');
    await expect(userMsg.first()).toContainText(`Base cwd: ${repo}`);
    await expect(userMsg.first()).toContainText('FULL MIGRATION ERROR');
    await expect(userMsg.first()).toContainText('FULL ROLLBACK ERROR');
  });
});
