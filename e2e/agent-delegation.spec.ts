import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAgentTab, sendAgentPrompt } from './helpers';

// Real Shelf main/app-tool/exec queue, fake model only. Result arrival must never
// create a main turn; A -> collect -> B reuses the same authorized delegation.
test.describe('worktree Agent delegation', () => {
  test.describe.configure({ timeout: 90_000 });
  let root: string, userData: string, app: ElectronApplication, page: Page;
  async function launch() {
    app = await electron.launch({ args: [path.join(__dirname, '..'), `--user-data-dir=${userData}`],
      env: { ...process.env, NODE_ENV: 'test', SHELF_TEST_MODE: '1' } });
    page = await app.firstWindow(); await page.waitForSelector('.app');
  }
  async function main() {
    await page.locator('.sidebar-item').filter({ hasText: 'Delegation Base' }).first().click();
    await page.locator('.tab-bar .tab').last().click();
  }
  async function spike() {
    await page.locator('.sidebar-item.worktree-child').first().click();
    await page.locator('.tab-bar .tab').last().click();
  }
  const panel = () => page.locator('.agent-view:visible .delegation-card');
  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-delegation-'));
    const repo = path.join(root, 'repo'), child = path.join(root, 'spike'); userData = path.join(root, 'data');
    fs.mkdirSync(repo); fs.mkdirSync(userData);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env });
    git('init', '-b', 'main'); git('commit', '--allow-empty', '-m', 'init'); git('worktree', 'add', '-b', 'spike', child);
    fs.writeFileSync(path.join(userData, 'projects.json'), JSON.stringify([{ id: 'base', name: 'Delegation Base', cwd: repo,
      connection: { type: 'local' }, maxTabs: 5, defaultTabs: [{ name: 'Terminal' }] }]));
    await launch();
    await page.locator('.connect-prompt').click();
    await expect(page.locator('.sidebar-item.worktree-child')).toHaveCount(1);
    await openAgentTab(page);
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
    await page.locator('.sidebar-item.worktree-child').click();
    await page.locator('.connect-prompt').click();
    await openAgentTab(page);
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
    await main();
  });
  test.afterEach(async () => { await app?.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  async function selectAndStart() {
    await sendAgentPrompt(page, 'delegation_select');
    const picker = page.getByRole('dialog', { name: 'Select delegated Agent' });
    await expect(picker).toBeVisible();
    await expect(picker.locator('.delegation-target')).toHaveCount(1);
    // Discovered children inherit Project.name; checkout path, not that name,
    // distinguishes the real worktree target from the base Project.
    await expect(picker.locator('.delegation-target')).toContainText('/spike');
    await picker.locator('.delegation-target').click();
    await expect(picker).not.toBeVisible();
    await expect(page.locator('.agent-messages:visible')).toContainText('delegation selection');
    await sendAgentPrompt(page, 'delegation_start:A');
    await expect(panel()).toContainText('Result ready');
    return panel().getAttribute('data-delegation-id');
  }
  test('manual collection and sequential phases preserve the relation; intervention rejects main work', async () => {
    const id = await selectAndStart();
    await expect(page.locator('.agent-messages:visible')).not.toContainText('EXPERIMENT RESULT A');
    await sendAgentPrompt(page, 'text:main continues independently');
    await expect(page.locator('.agent-messages:visible')).toContainText('main continues independently');
    await sendAgentPrompt(page, 'delegation_status');
    await expect(page.locator('.agent-messages:visible')).toContainText('"hasResult":true');
    await expect(page.locator('.agent-messages:visible')).not.toContainText('EXPERIMENT RESULT A');
    await panel().getByRole('button', { name: 'Collect result' }).click();
    await expect(page.locator('.agent-messages:visible')).toContainText('EXPERIMENT RESULT A');
    await expect(panel().getByRole('button', { name: 'Collect result' })).toBeDisabled();
    await sendAgentPrompt(page, 'delegation_send:B');
    await expect(panel()).toContainText('Result ready');
    expect(await panel().getAttribute('data-delegation-id')).toBe(id);
    await panel().getByRole('button', { name: 'Intervene', exact: true }).click();
    await expect(page.locator('.sidebar-item.active')).toContainText('spike');
    await expect(page.locator('.agent-textarea:visible')).not.toHaveAttribute('readonly', '');
    await sendAgentPrompt(page, 'text:human debugging');
    await expect(page.locator('.agent-messages:visible')).toContainText('human debugging');
    await main(); await sendAgentPrompt(page, 'delegation_send:C');
    await expect(page.locator('.agent-messages:visible')).toContainText('User intervention in progress');
    await panel().getByRole('button', { name: 'End intervention' }).click();
    await spike(); await expect(page.locator('.agent-textarea:visible')).toHaveAttribute('readonly', '');
    await main(); await panel().getByRole('button', { name: 'Collect result' }).click();
    await expect(page.locator('.agent-messages:visible')).toContainText('EXPERIMENT RESULT B');
    await panel().getByRole('button', { name: 'Stop delegation' }).click();
    await expect(panel()).toHaveCount(0);
    await spike(); await sendAgentPrompt(page, 'text:worker remains usable');
    await expect(page.locator('.agent-messages:visible')).toContainText('worker remains usable');
  });
  test('picker cancellation and closing a View protect uncollected results', async () => {
    await sendAgentPrompt(page, 'delegation_select');
    await page.getByRole('dialog', { name: 'Select delegated Agent' }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.agent-messages:visible')).toContainText('"cancelled":true');
    await expect(panel()).toHaveCount(0);
    await selectAndStart();
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 1 }); });
    await page.locator('.tab-bar .tab').last().locator('.tab-close').click();
    await expect(panel()).toContainText('Result ready');
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0 }); });
    await page.locator('.tab-bar .tab').last().locator('.tab-close').click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
    await spike(); await expect(panel()).toHaveCount(0);
    await expect(page.locator('.agent-textarea:visible')).not.toHaveAttribute('readonly', '');
  });
  test('stopping detaches a still-running worker and rejects its late report without killing the execution', async () => {
    await sendAgentPrompt(page, 'delegation_select');
    await page.getByRole('dialog', { name: 'Select delegated Agent' }).locator('.delegation-target').click();
    await expect(page.locator('.agent-messages:visible')).toContainText('delegation selection');
    await sendAgentPrompt(page, 'delegation_start:slow:A');
    await expect(panel()).toContainText('Checking slow:A');
    const id = await panel().getAttribute('data-delegation-id');
    await panel().getByRole('button', { name: 'Stop delegation' }).click();
    await expect(panel()).toHaveCount(0);
    await spike();
    await expect(page.locator('.agent-messages:visible')).toContainText('Delegation no longer exists');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
    await sendAgentPrompt(page, `delegation_old_result:${id}`);
    await expect(page.locator('.agent-messages:visible')).toContainText('late report {"ok":false');
  });
  test('restart discards prototype delegation state and uncollected result', async () => {
    await selectAndStart();
    expect(await page.evaluate(() => window.shelfApi.delegation.current())).toHaveLength(1);
    await app.close(); await launch();
    expect(await page.evaluate(() => window.shelfApi.delegation.current())).toEqual([]);
    await expect(page.locator('.delegation-card')).toHaveCount(0);
  });
  test('collection queues behind a busy main turn without waiting for that turn to finish', async () => {
    await selectAndStart();
    await sendAgentPrompt(page, 'delay:2000|text:busy main finished');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('running');
    await panel().getByRole('button', { name: 'Collect result' }).click();
    await expect(panel().getByRole('button', { name: 'Collect result' })).toBeDisabled();
    await expect(page.locator('.agent-status-label:visible')).toHaveText('running');
    await expect(page.locator('.agent-messages:visible')).toContainText('EXPERIMENT RESULT A');
    await expect(page.locator('.agent-messages:visible')).toContainText('busy main finished');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
    expect((await page.evaluate(() => window.shelfApi.delegation.current()))[0].resultState).toBeNull();
  });
});
