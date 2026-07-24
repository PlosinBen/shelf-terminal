import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { openAgentTab, sendAgentPrompt } from './helpers';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * worktree_project_create E2E — the agent-driven create gate.
 *
 * Drives the full round-trip over the fake provider's generic `apptool:<op>:<args>`
 * scenario: agent-server callMain('worktree_project.create', {...}) → main
 * handleAppTool → requestWorktreeCreate → the client-owned confirm popup
 * (WorktreeCreateGate) → on approve the renderer runs worktreeAdd + migrate note +
 * add sub-project and reports the outcome back to the agent.
 *
 * A real temp git repo is seeded as the base project so worktreeAdd actually cuts
 * a worktree; the popup gate + outcome wiring is what this proves (git internals
 * are unit-tested separately).
 */

const PROJECT_ID = 'wt-base-project';
const BASE_BRANCH = 'main';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wt-repo-'));
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
  // worktree add -b needs a committed HEAD — empty repo has none.
  git(['commit', '--allow-empty', '-m', 'init']);
  return repo;
}

function seedProject(userDataDir: string, repo: string) {
  const project = {
    id: PROJECT_ID,
    name: 'WT Base',
    cwd: repo,
    connection: { type: 'local' },
    maxTabs: 5,
    // Setup fields a worktree should inherit.
    envPlain: { WT_INHERIT: 'yes' },
    quickCommands: [{ label: 'build', command: 'npm run build', target: 'current' }],
    // A session id that must NOT be inherited (worktree boots a fresh agent).
    agentSessionIds: { claude: 'parent-session' },
  };
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([project]), 'utf-8');
}

function readProjects(userDataDir: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8'));
}

async function connectAndOpenAgent(page: Page) {
  await page.locator('.sidebar-item').first().click();
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 8_000 });
  await openAgentTab(page);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
}

test.describe('worktree_project_create gate', () => {
  let userDataDir: string;
  let repo: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wt-e2e-'));
    repo = makeRepo();
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
    // Clean the repo AND its worktree sibling(s).
    const parent = path.dirname(repo);
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(path.basename(repo))) {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      }
    }
  });

  test('approve cuts a worktree sub-project and reports created:true', async () => {
    await connectAndOpenAgent(page);

    await sendAgentPrompt(page, 'apptool:worktree_project.create:{"branch":"feature/x"}');

    // The confirm popup surfaces the agent-supplied branch, the fork branch
    // (parent's current branch) and the parent name.
    const popup = page.locator('.worktree-dialog', { hasText: 'Create Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup).toContainText('feature/x');
    await expect(popup).toContainText('from main'); // fork point
    await expect(popup).toContainText('WT Base');

    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    // A worktree sub-project appeared in the sidebar (branch label rendered).
    await expect(page.locator('.project-branch', { hasText: 'feature/x' })).toBeVisible({ timeout: 8_000 });
    // The worktree dir was actually cut on disk (sibling of the base repo).
    expect(fs.existsSync(`${repo}-feature-x`)).toBe(true);
    // The agent got a calm success result carrying created:true.
    await expect(page.locator('.agent-turn-response')).toContainText('"created":true', { timeout: 8_000 });

    // The worktree auto-connected (no lingering connect prompt for the active project).
    await expect(page.locator('.connect-prompt')).toHaveCount(0, { timeout: 8_000 });

    // The child inherited the parent's setup but got a fresh identity.
    const child = readProjects(userDataDir).find((p) => p.parentProjectId === PROJECT_ID);
    expect(child).toBeTruthy();
    expect(child.envPlain).toEqual({ WT_INHERIT: 'yes' });
    expect(child.quickCommands).toEqual([{ label: 'build', command: 'npm run build', target: 'current' }]);
    expect(child.worktreeBranch).toBe('feature/x');
    expect(child.baseBranch).toBe('main');
    // NEVER inherit the parent's agent session — the worktree boots fresh.
    expect(child.agentSessionIds).toBeUndefined();
  });

  test('cancel creates nothing and reports created:false', async () => {
    await connectAndOpenAgent(page);

    await sendAgentPrompt(page, 'apptool:worktree_project.create:{"branch":"feature/y"}');

    const popup = page.locator('.worktree-dialog', { hasText: 'Create Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.conn-btn-cancel').click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });

    // No worktree sub-project, no worktree dir, and the agent sees a calm decline.
    await expect(page.locator('.project-branch', { hasText: 'feature/y' })).toHaveCount(0);
    expect(fs.existsSync(`${repo}-feature-y`)).toBe(false);
    await expect(page.locator('.agent-turn-response')).toContainText('"created":false', { timeout: 8_000 });
  });

  test('with notePath: the feature note moves into the worktree', async () => {
    // Seed a Phase-0 note in the base repo.
    const noteRel = '.agent/features/demo.md';
    fs.mkdirSync(path.join(repo, '.agent', 'features'), { recursive: true });
    fs.writeFileSync(path.join(repo, noteRel), '# demo note', 'utf-8');

    await connectAndOpenAgent(page);

    await sendAgentPrompt(page, `apptool:worktree_project.create:{"branch":"feature/z","notePath":"${noteRel}"}`);

    const popup = page.locator('.worktree-dialog', { hasText: 'Create Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup).toContainText(noteRel);
    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    await expect(page.locator('.agent-turn-response')).toContainText('"created":true', { timeout: 8_000 });
    // copy-then-delete-on-success: note now in the worktree, gone from the base.
    expect(fs.existsSync(path.join(`${repo}-feature-z`, noteRel))).toBe(true);
    expect(fs.existsSync(path.join(repo, noteRel))).toBe(false);
  });
});
