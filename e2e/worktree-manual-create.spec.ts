import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { CLAUDE_PROVIDER, CODEX_PROVIDER } from '../src/shared/agent-providers';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { openAgentTab } from './helpers';
import { FAKE_TEST_ENV } from '../agent-server/providers/fake/test-env';

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
  richParent = false,
) {
  const project = {
    id: PROJECT_ID,
    name: 'WT Base',
    cwd: repo,
    connection: { type: 'local' },
    maxTabs: 5,
    defaultAgentProvider: CLAUDE_PROVIDER,
    featureNoteDir,
    ...(richParent ? {
      defaultTabs: [{ name: 'Parent shell', cmd: 'echo parent' }, { name: 'Parent second shell' }],
      agentSessionIds: { [CLAUDE_PROVIDER]: 'parent-startup-session' },
      agentPrefs: { [CLAUDE_PROVIDER]: { model: 'parent-model' } },
    } : {}),
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
    seedProject(userDataDir, repo, featureNoteDir, title.includes('agent proposal'), title.includes('startup selections'));
    const forceCreateFailure = testInfo.titlePath.join(' ').includes('migration rollback failure');
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        SHELF_TEST_MODE: '1',
        NODE_ENV: 'test',
        ...(title.includes('preference inheritance') ? { [FAKE_TEST_ENV.NATIVE_PERMISSIONS]: '1', [FAKE_TEST_ENV.NATIVE_APPROVAL]: '1', LOG_LEVEL: 'info' } : {}),
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

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      fs.writeFileSync(testInfo.outputPath('main.log'), readLogText(userDataDir));
      const projectFile = path.join(userDataDir, 'projects.json');
      if (fs.existsSync(projectFile)) fs.copyFileSync(projectFile, testInfo.outputPath('projects.json'));
      const currentPage = app.windows()[0];
      if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: testInfo.outputPath('failure.png') });
    }
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
    const startupOverride = dialog.locator('.worktree-startup-tabs-override');
    await expect(startupOverride).toHaveValue('');
    await expect(startupOverride.locator('option').first()).toHaveText('None');
    await expect(dialog.locator('.worktree-startup-terminal')).toBeChecked();
    await expect(startupOverride.locator(`option[value="${CLAUDE_PROVIDER}"]`))
      .toHaveText('Claude');

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
      projects: Array<{ parentProjectId?: string; featureNoteDir?: string; defaultTabs?: unknown[] }>;
    };
    expect(document.schemaVersion).toBe(4);
    const child = document.projects.find((project) => project.parentProjectId === PROJECT_ID);
    expect(child?.featureNoteDir).toBe('.agent/features');
    expect(child?.defaultTabs).toEqual([
      { name: 'Terminal' },
    ]);

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

  test('startup tabs override replaces the inherited list with the selected Agent and Terminal', async () => {
    const dialog = await openNewWorktreeDialog(page);
    await dialog.locator('.worktree-startup-tabs-override').selectOption(CODEX_PROVIDER);
    await dialog.locator('.worktree-input').fill('feature/codex-startup');
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });

    const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8')) as {
      projects: Array<{
        parentProjectId?: string;
        defaultTabs?: unknown[];
        agentViews?: Record<string, { provider: string; prefs: unknown }>;
      }>;
    };
    const child = document.projects.find((project) => project.parentProjectId === PROJECT_ID);
    expect(child?.defaultTabs).toEqual([
      { name: 'Codex', kind: 'agent', provider: CODEX_PROVIDER, sessionId: expect.any(String) },
      { name: 'Terminal' },
    ]);
    expect(Object.values(child?.agentViews ?? {})).toEqual([{ provider: CODEX_PROVIDER, prefs: {} }]);
  });

  for (const choice of [
    { name: 'Terminal only', agent: '', terminal: true, labels: ['Terminal'] },
    { name: 'Agent only', agent: CLAUDE_PROVIDER, terminal: false, labels: ['Claude'] },
    { name: 'Agent and Terminal', agent: CLAUDE_PROVIDER, terminal: true, labels: ['Claude', 'Terminal'] },
  ]) {
    test(`startup selections create ${choice.name} with fresh state`, async () => {
      const dialog = await openNewWorktreeDialog(page);
      await dialog.locator('.worktree-startup-tabs-override').selectOption(choice.agent);
      await dialog.locator('.worktree-startup-terminal').setChecked(choice.terminal);
      await dialog.locator('.worktree-input').fill('feature/selected-startup');
      await dialog.locator('.conn-btn-next').click();
      await expect(dialog).not.toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.tab-bar .tab-label')).toHaveText(choice.labels);
      if (choice.agent) await expect(page.locator('.agent-textarea:visible')).toBeVisible();
      const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf8'));
      const child = document.projects.find((project: { parentProjectId?: string }) => project.parentProjectId === PROJECT_ID);
      expect(child.defaultTabs).toEqual([
        ...(choice.agent ? [{ name: 'Claude', kind: 'agent', provider: CLAUDE_PROVIDER, sessionId: expect.any(String) }] : []),
        ...(choice.terminal ? [{ name: 'Terminal' }] : []),
      ]);
      expect(Object.values(child.agentViews)).toEqual(choice.agent ? [{ provider: CLAUDE_PROVIDER, prefs: { model: 'parent-model' } }] : []);
      expect(Object.keys(child.agentViews)).not.toContain('parent-startup-session');
      const parent = document.projects.find((project: { id: string }) => project.id === PROJECT_ID);
      expect(parent.defaultTabs).toContainEqual({ name: 'Parent shell', cmd: 'echo parent' });
      expect(parent.agentViews['parent-startup-session'].prefs.model).toBe('parent-model');
    });
  }

  test('preference inheritance requires a source when multiple same-provider Views have no active Agent', async () => {
    await openAgentTab(page);
    await openAgentTab(page);
    await page.locator('[data-config-key="nativePermission"]:visible').click();
    await page.locator('.agent-perm-option:visible', { hasText: 'On' }).click();
    await page.locator('[data-config-key="nativeApproval"]:visible').click();
    await page.locator('.agent-perm-option:visible', { hasText: 'never' }).click();
    await expect(page.locator('[data-config-key="nativeApproval"]:visible')).toHaveText('Approval: never');
    const parent = (await page.evaluate(() => window.shelfApi.project.getAll())).find(p => p.id === PROJECT_ID)!;
    const source = Object.entries(parent.agentViews).find(([, view]) => view.prefs.nativePermission === 'on')![0];
    // Active View is preferred even with two candidates.
    const activeDialog = await openNewWorktreeDialog(page);
    await activeDialog.locator('.worktree-startup-tabs-override').selectOption(CLAUDE_PROVIDER);
    await expect(activeDialog.getByLabel('Copy Agent settings from')).toHaveValue(source);
    await activeDialog.locator('.settings-close').click();
    // A new terminal has no preference source, so the same candidates are ambiguous.
    await page.locator('.tab-add').click();
    await page.locator('.context-menu-item', { hasText: /^Terminal$/ }).click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(3);
    const dialog = await openNewWorktreeDialog(page);
    await dialog.locator('.worktree-startup-tabs-override').selectOption(CLAUDE_PROVIDER);
    await dialog.locator('.worktree-input').fill('feature/inherited-prefs');
    const sourceSelect = dialog.getByLabel('Copy Agent settings from');
    await expect(sourceSelect).toHaveValue('');
    await expect(dialog.locator('.conn-btn-next')).toBeDisabled();
    await sourceSelect.selectOption(source);
    await dialog.locator('.worktree-startup-terminal').uncheck();
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-config-key="nativePermission"]:visible')).toHaveText('Allow all: On');
    await expect(page.locator('[data-config-key="nativeApproval"]:visible')).toHaveText('Approval: never');
    const projects = await page.evaluate(() => window.shelfApi.project.getAll());
    const child = projects.find(p => p.parentProjectId === PROJECT_ID)!;
    expect(Object.keys(child.agentViews)).not.toContain(source);
    expect(Object.values(child.agentViews)[0].prefs).toEqual(parent.agentViews[source].prefs);
  });

  test('preference inheritance uses the MCP caller even after switching to another same-provider View', async () => {
    await openAgentTab(page);
    await page.locator('[data-config-key="nativePermission"]:visible').click();
    await page.locator('.agent-perm-option:visible', { hasText: 'On' }).click();
    await page.locator('[data-config-key="nativeApproval"]:visible').click();
    await page.locator('.agent-perm-option:visible', { hasText: 'never' }).click();
    await expect(page.locator('[data-config-key="nativeApproval"]:visible')).toHaveText('Approval: never');
    const parent = (await page.evaluate(() => window.shelfApi.project.getAll())).find(p => p.id === PROJECT_ID)!;
    const caller = Object.entries(parent.agentViews).find(([, view]) => view.prefs.nativePermission === 'on')![0];
    await openAgentTab(page);
    // Return to the configured caller, send its proposal, then activate the other Agent.
    await page.locator('.tab-bar .tab').nth(0).click();
    const textarea = page.locator('.agent-textarea:visible');
    await textarea.fill(`delay:1200|worktree_create:feature/caller-prefs demo.md ${CLAUDE_PROVIDER}`);
    await textarea.press('Enter');
    await page.locator('.tab-bar .tab').nth(1).click();
    const dialog = page.locator('.worktree-dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByLabel('Copy Agent settings from')).toHaveValue(caller);
    await dialog.locator('.worktree-startup-terminal').uncheck();
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-config-key="nativePermission"]:visible')).toHaveText('Allow all: On');
    await expect(page.locator('[data-config-key="nativeApproval"]:visible')).toHaveText('Approval: never');
  });

  test('empty startup selection blocks Create and Enter, recovers, and resets on reopen', async () => {
    let dialog = await openNewWorktreeDialog(page);
    await dialog.locator('.worktree-input').fill('feature/empty-startup');
    await dialog.locator('.worktree-note-row', { hasText: 'demo.md' }).locator('input').check();
    await dialog.locator('.worktree-startup-terminal').uncheck();
    await expect(dialog.locator('.conn-btn-next')).toBeDisabled();
    await expect(dialog.locator('.worktree-startup-error')).toContainText('Select at least one initial view');
    await dialog.locator('.worktree-input').press('Enter');
    await expect(dialog).toBeVisible();
    expect(fs.existsSync(`${repo}-feature-empty-startup`)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.agent/features/demo.md'))).toBe(true);
    await expect(page.locator('.sidebar-item.worktree-child')).toHaveCount(0);
    await dialog.locator('.worktree-startup-tabs-override').selectOption(CODEX_PROVIDER);
    await expect(dialog.locator('.worktree-startup-error')).toHaveCount(0);
    await expect(dialog.locator('.worktree-error-text')).toHaveCount(0);
    await expect(dialog.locator('.conn-btn-next')).toBeEnabled();
    await dialog.locator('.settings-close').click();
    dialog = await openNewWorktreeDialog(page);
    await expect(dialog.locator('.worktree-startup-tabs-override')).toHaveValue('');
    await expect(dialog.locator('.worktree-startup-terminal')).toBeChecked();
    await expect(dialog.locator('.worktree-startup-error')).toHaveCount(0);
  });

  test('main rejects an empty startup selection before a real Git worktree is created', async () => {
    const savedProjects = fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf8');
    const result = await page.evaluate(async (cwd) => window.shelfApi.git.worktreeAdd(
      { type: 'local' }, cwd, 'feature/rejected-startup', true, { startupTerminal: false },
    ), repo);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Select at least one initial view') });
    expect(fs.existsSync(`${repo}-feature-rejected-startup`)).toBe(false);
    expect(execFileSync('git', ['branch', '--list', 'feature/rejected-startup'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('');
    expect(fs.existsSync(path.join(repo, '.agent/features/demo.md'))).toBe(true);
    await expect(page.locator('.sidebar-item.worktree-child')).toHaveCount(0);
    expect(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf8')).toBe(savedProjects);
  });

  for (const agent of ['', CLAUDE_PROVIDER]) {
    test(`agent proposal prefill can be overridden to ${agent || 'None'} before Create`, async () => {
      await openAgentTab(page);
      const textarea = page.locator('.agent-textarea:visible');
      await textarea.fill(`worktree_create:feature/override demo.md ${CODEX_PROVIDER}`);
      await textarea.press('Enter');
      const dialog = page.locator('.worktree-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.worktree-startup-tabs-override')).toHaveValue(CODEX_PROVIDER);
      await dialog.locator('.worktree-startup-tabs-override').selectOption(agent);
      await dialog.locator('.conn-btn-next').click();
      await expect(dialog).not.toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.tab-bar .tab-label')).toHaveText(agent ? ['Claude', 'Terminal'] : ['Terminal']);
      const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf8'));
      const child = document.projects.find((project: { parentProjectId?: string }) => project.parentProjectId === PROJECT_ID);
      expect(Object.values(child.agentViews)).toEqual(agent ? [{ provider: CLAUDE_PROVIDER, prefs: {} }] : []);
    });
  }

  test('legacy secret files do not block durable child creation or auto-connect', async () => {
    const legacyFiles = new Map([
      ['project-secrets.json', 'retired side-car: do not parse or copy'],
      ['secret-key.local', 'retired local key'],
      ['secret-key.enc', 'retired OS-wrapped key'],
    ]);
    for (const [name, content] of legacyFiles) fs.writeFileSync(path.join(userDataDir, name), content);
    const dialog = await openNewWorktreeDialog(page);
    await dialog.locator('.worktree-input').fill('feature/plain-env-child');
    await dialog.locator('.conn-btn-next').click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature/plain-env-child' })).toHaveCount(1);
    await expect(page.locator('.connect-prompt')).toHaveCount(0, { timeout: 8_000 });
    const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf8'));
    expect(document.projects).toHaveLength(2);
    for (const [name, content] of legacyFiles) expect(fs.readFileSync(path.join(userDataDir, name), 'utf8')).toBe(content);
  });

  test('agent proposal pre-fills the dialog but still requires the user to Create', async () => {
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
    const textarea = page.locator('.agent-textarea:visible');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill(`delay:800|worktree_create:feature/proposed demo.md ${CODEX_PROVIDER}`);
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
    await expect(dialog.locator('.worktree-startup-tabs-override')).toHaveValue(CODEX_PROVIDER);
    await expect(dialog.locator('.worktree-startup-terminal')).toBeChecked();
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
