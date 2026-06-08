import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Background-tasks panel — end-to-end over the fake provider (SHELF_TEST_MODE=1).
 * Exercises the turnId-less task_event lane all the way to the renderer:
 * a running task shows in the "N tasks" panel, a completed task exposes its
 * output via read_task_output, and tasks can be dismissed. Scenarios:
 *   task:<id>     → running background task_event
 *   taskdone:<id> → completed task_event + stashed output (fetchTaskOutput)
 * See DECISIONS #69 and agent-server/providers/fake/index.ts.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
}

test.describe('background tasks panel via fake provider', () => {
  test('running task appears in the panel (auto-expanded)', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'task:t1');

    const panel = page.locator('.agent-tasks-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel.locator('.agent-tasks-label')).toContainText('1 running');
    // Auto-expanded while running → the item + label render.
    const item = panel.locator('.agent-task-item.agent-task-running');
    await expect(item).toBeVisible();
    await expect(item.locator('.agent-task-label')).toContainText('bg t1');
  });

  test('auto-resume prose renders as its own (user-less) turn block', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    // serverturn: drives the M3 server-initiated turn end-to-end (wire
    // turn_started → dispatcher registers → main forwarder → renderer
    // buildTurns opens a fresh block). See background-tasks.md M3.
    await sendAgentPrompt(page, 'serverturn:the sleep finished');

    // The prose appears...
    await expect(page.locator('.agent-turn-response')).toContainText('the sleep finished', { timeout: 5_000 });

    // ...in an agent-only turn block (no user bubble) — i.e. it did NOT glue
    // onto the prompt's turn. The server turn is the LAST .agent-turn and it
    // contains the prose but no user message.
    const serverBlock = page.locator('.agent-turn').last();
    await expect(serverBlock).toContainText('the sleep finished');
    await expect(serverBlock.locator('.agent-msg-user')).toHaveCount(0);
  });

  test('completed task: read output + dismiss', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    // Start it running, then complete it (two turns).
    await sendAgentPrompt(page, 'task:t1');
    await expect(page.locator('.agent-tasks-panel:visible')).toBeVisible({ timeout: 5_000 });
    await sendAgentPrompt(page, 'taskdone:t1');

    const panel = page.locator('.agent-tasks-panel:visible');
    // Completed → no "running", panel auto-collapses; expand via header.
    await expect(panel.locator('.agent-tasks-label')).toHaveText('1 task', { timeout: 5_000 });
    await panel.locator('.agent-tasks-header').click();

    const item = panel.locator('.agent-task-item.agent-task-completed');
    await expect(item).toBeVisible();
    await expect(item.locator('.agent-task-summary')).toContainText('completed (exit 0)');

    // Click the (clickable) completed row → fetchTaskOutput → output shows.
    await item.locator('.agent-task-row').click();
    await expect(item.locator('.agent-task-output')).toContainText('output of t1', { timeout: 5_000 });

    // Dismiss the only task → panel disappears.
    await item.locator('.agent-task-dismiss').click();
    await expect(page.locator('.agent-tasks-panel')).toHaveCount(0, { timeout: 5_000 });
  });
});
