import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Background-tasks panel — end-to-end over the fake provider (SHELF_TEST_MODE=1).
 * Exercises the turnId-less task_event lane all the way to the renderer:
 * a running task shows in the "N tasks" panel, a completed task exposes its
 * output via read_task_output, tasks can be dismissed, and a cleanly-completed
 * card auto-dismisses after a countdown (shrunk via a window override) while a
 * failed/engaged card does not. Scenarios:
 *   task:<id>     → running background task_event
 *   taskdone:<id> → completed task_event + stashed output (fetchTaskOutput)
 *   taskfail:<id> → failed (errored) terminal task_event
 * See background-tasks#2 / #4 and agent-server/providers/fake/index.ts.
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
    // buildTurns opens a fresh block). See background-tasks#2.
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
    // Collapsed shows only the description — summary is hidden until expanded.
    await expect(item.locator('.agent-task-summary')).toHaveCount(0);

    // Click the row → expand: summary + output appear (fetchTaskOutput).
    await item.locator('.agent-task-row').click();
    await expect(item.locator('.agent-task-summary')).toContainText('completed (exit 0)', { timeout: 5_000 });
    await expect(item.locator('.agent-task-output')).toContainText('output of t1', { timeout: 5_000 });

    // Dismiss the only task → panel disappears.
    await item.locator('.agent-task-dismiss').click();
    await expect(page.locator('.agent-tasks-panel')).toHaveCount(0, { timeout: 5_000 });
  });

  test('a cleanly-completed task auto-dismisses after the countdown', async ({ shelfApp: { page } }) => {
    // Shrink the 30s auto-dismiss so the test doesn't wait 30s. Read lazily by
    // the panel, so setting it before the task settles is enough (no reload). A
    // couple of seconds leaves room to observe the bar before removal without
    // making the test slow.
    await page.evaluate(() => { (window as { __SHELF_TASK_AUTO_REMOVE_MS__?: number }).__SHELF_TASK_AUTO_REMOVE_MS__ = 2000; });

    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'taskdone:t1');

    const panel = page.locator('.agent-tasks-panel:visible');
    await expect(panel.locator('.agent-tasks-label')).toHaveText('1 task', { timeout: 5_000 });
    await panel.locator('.agent-tasks-header').click();

    const item = panel.locator('.agent-task-item.agent-task-completed');
    await expect(item).toBeVisible();
    // The countdown bar renders for a cleanly-completed card...
    await expect(item.locator('.agent-task-countdown')).toBeVisible();
    // ...and the card auto-removes when it elapses (whole panel goes once empty).
    await expect(page.locator('.agent-tasks-panel')).toHaveCount(0, { timeout: 5_000 });
  });

  test('a failed task is NOT auto-dismissed and shows no countdown', async ({ shelfApp: { page } }) => {
    await page.evaluate(() => { (window as { __SHELF_TASK_AUTO_REMOVE_MS__?: number }).__SHELF_TASK_AUTO_REMOVE_MS__ = 600; });

    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'taskfail:t1');

    const panel = page.locator('.agent-tasks-panel:visible');
    await expect(panel.locator('.agent-tasks-label')).toHaveText('1 task', { timeout: 5_000 });
    await panel.locator('.agent-tasks-header').click();

    const item = panel.locator('.agent-task-item.agent-task-failed');
    await expect(item).toBeVisible();
    // A failed card never gets a countdown bar...
    await expect(item.locator('.agent-task-countdown')).toHaveCount(0);
    // ...and is still there well after the (shrunk) countdown would have fired —
    // the user must see the failure. It only leaves via an explicit dismiss.
    await page.waitForTimeout(1500);
    await expect(item).toBeVisible();
    await item.locator('.agent-task-dismiss').click();
    await expect(page.locator('.agent-tasks-panel')).toHaveCount(0, { timeout: 5_000 });
  });

  test('expanding a completed task cancels its auto-dismiss', async ({ shelfApp: { page } }) => {
    await page.evaluate(() => { (window as { __SHELF_TASK_AUTO_REMOVE_MS__?: number }).__SHELF_TASK_AUTO_REMOVE_MS__ = 600; });

    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'taskdone:t1');

    const panel = page.locator('.agent-tasks-panel:visible');
    await expect(panel.locator('.agent-tasks-label')).toHaveText('1 task', { timeout: 5_000 });
    await panel.locator('.agent-tasks-header').click();

    const item = panel.locator('.agent-task-item.agent-task-completed');
    await expect(item).toBeVisible();
    // Engage: expand the row → countdown is cancelled (and the bar disappears).
    await item.locator('.agent-task-row').click();
    await expect(item.locator('.agent-task-countdown')).toHaveCount(0);
    // Survives well past when the countdown would have removed it.
    await page.waitForTimeout(1500);
    await expect(item).toBeVisible();
  });

  test('running task: two-step Stop kills it through the SDK, then removes the card on confirmation', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'task:t1');

    const panel = page.locator('.agent-tasks-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    const item = panel.locator('.agent-task-item.agent-task-running');
    await expect(item).toBeVisible();

    // A RUNNING task has a distinct danger "Stop" button (not the × dismiss) and
    // a two-step confirm so an accidental click can't kill live work. First click
    // arms ("Stop?"); second click sends stopTask to the backend, which echoes a
    // terminal 'stopped' task_event. The panel keeps the card ("stopping…") until
    // that confirmation arrives, then removes it — so the panel only disappears
    // once the stop round-tripped through the SDK.
    const stop = item.locator('.agent-task-stop');
    await expect(stop).toHaveText(/^Stop$/);
    await stop.click();                       // arm
    await expect(stop).toHaveText(/^Stop\?$/); // armed
    await stop.click();                       // confirm → stopTask
    await expect(page.locator('.agent-tasks-panel')).toHaveCount(0, { timeout: 5_000 });
  });
});

test.describe('plan/todo vs background tasks — distinct surfaces', () => {
  test('plan-panel renders the todo list independently of the timeline', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'plan:PLAN_MARKER_ONE');

    const plan = page.locator('.agent-plan-panel:visible');
    await expect(plan).toBeVisible({ timeout: 5_000 });
    await expect(plan.locator('.agent-plan-header')).toContainText('Plan');
    await expect(plan.locator('.agent-plan-body')).toContainText('PLAN_MARKER_ONE');
    // The plan is a side-channel panel, NOT an agent timeline message — the only
    // place the marker appears in the timeline is the user's own prompt echo, so
    // there is no agent reply / fold card carrying it.
    await expect(page.locator('.agent-messages .agent-turn-response').getByText('PLAN_MARKER_ONE')).toHaveCount(0);
  });

  test('plan-panel and background-tasks-panel render side by side as separate panels', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // One turn emits BOTH a plan/todo update and a running background task.
    await sendAgentPrompt(page, 'plan:PLAN_MARKER_TWO|task:bgjob');

    const plan = page.locator('.agent-plan-panel:visible');
    const tasks = page.locator('.agent-tasks-panel:visible');
    // Both surfaces render, distinctly — the todo list in the plan panel, the
    // live job in the tasks panel (with its running spinner + Stop affordance).
    await expect(plan).toBeVisible({ timeout: 5_000 });
    await expect(plan.locator('.agent-plan-body')).toContainText('PLAN_MARKER_TWO');
    await expect(tasks).toBeVisible({ timeout: 5_000 });
    await expect(tasks.locator('.agent-task-item.agent-task-running')).toBeVisible();
    await expect(tasks.locator('.agent-task-label')).toContainText('bg bgjob');
    // They are two different DOM panels (not one shared list).
    await expect(plan).not.toHaveClass(/agent-tasks-panel/);
  });
});
