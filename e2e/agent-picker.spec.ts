import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Agent picker E2E — exercises the full wire chain:
 *   renderer agent input → main IPC → agent-server (fake provider) →
 *   picker_request → renderer PickerPanel → user click → resolve_picker
 *   IPC → fake provider echoes answers as a text message → renderer asserts.
 *
 * Fake provider is enabled by SHELF_TEST_MODE=1 set in helpers.ts. Scenarios
 * documented in `agent-server/providers/fake.ts`.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// Mirrors features.spec.ts setupProject — duplicated here rather than shared
// because the auxiliary helpers tab kept the setup flow local-friendly.
async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  // See agent-flows.spec.ts setupProject — wait for path to populate so
  // Cmd+Enter doesn't fire mid-listDir and confirm with empty cwd.
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

test.describe('agent picker via fake provider', () => {
  test('single-select picker: click option → resolves with selected label', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'picker_single');

    // `:visible` scoping — worker-scoped Electron carries prior tests'
    // agent-views in inactive projects; we only target the active one.
    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel.locator('.picker-option')).toHaveCount(3);

    // Click option "B" then Submit.
    await panel.locator('.picker-option', { hasText: 'B' }).click();
    await panel.locator('.picker-btn-primary').click();

    // Fake provider echoes the answers JSON back as a text message.
    await expect(page.locator('.agent-messages:visible')).toContainText('picker_answers:["B"]', { timeout: 5_000 });
  });

  test('multi-prompt picker: navigates back/forward and collects mixed answers', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'picker_multi');

    // `:visible` scoping — worker-scoped Electron carries prior tests'
    // agent-views in inactive projects; we only target the active one.
    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // Progress indicator shows multi-prompt mode.
    await expect(panel.locator('.picker-progress')).toContainText('Question 1 of 3');

    // Prompt 1 — single-select color.
    await panel.locator('.picker-option', { hasText: 'red' }).click();
    await panel.locator('.picker-btn-primary', { hasText: 'Next' }).click();

    // Prompt 2 — multi-select toppings.
    await expect(panel.locator('.picker-progress')).toContainText('Question 2 of 3');
    await panel.locator('.picker-option', { hasText: 'cheese' }).click();
    await panel.locator('.picker-option', { hasText: 'olives' }).click();
    await panel.locator('.picker-btn-primary', { hasText: 'Next' }).click();

    // Prompt 3 — free-text input.
    await expect(panel.locator('.picker-progress')).toContainText('Question 3 of 3');
    await panel.locator('.picker-other-input').fill('urgent');
    await panel.locator('.picker-btn-primary', { hasText: 'Submit' }).click();

    await expect(page.locator('.agent-messages:visible')).toContainText(
      'picker_answers:["red",["cheese","olives"],"urgent"]',
      { timeout: 5_000 },
    );
  });

  test('options+free-text picker: type own answer without picking an option → resolves with typed text', async ({ shelfApp: { page } }) => {
    // The real AskUserQuestion shape — every prompt carries options AND a
    // free-text input (claude helpers hardcode inputType:'text'). Guards that
    // Shelf does NOT have the harness-picker limitation where you're forced
    // to select a listed option before you can submit your own text.
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'picker_combo');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // Both the options AND the free-text input are present.
    await expect(panel.locator('.picker-option')).toHaveCount(3);
    await expect(panel.locator('.picker-other-input')).toBeVisible();

    // Submit is disabled until SOME answer exists (no option picked, no text).
    await expect(panel.locator('.picker-btn-primary')).toBeDisabled();

    // Type a custom answer — do NOT click any option.
    await panel.locator('.picker-other-input').fill('my own answer');

    // Typed text alone satisfies the prompt → Submit becomes enabled.
    await expect(panel.locator('.picker-btn-primary')).toBeEnabled();
    await panel.locator('.picker-btn-primary').click();

    await expect(page.locator('.agent-messages:visible')).toContainText(
      'picker_answers:["my own answer"]',
      { timeout: 5_000 },
    );
  });

  test('options+free-text picker: pressing Enter inside the input submits the typed answer', async ({ shelfApp: { page } }) => {
    // Regression: with the cursor in the free-text input and no option picked,
    // pressing Enter must submit (the hint advertises "Enter submit"). Earlier
    // the Enter handler bailed whenever the input was focused, so a user who
    // typed an answer and hit Enter — the natural gesture, and the only one
    // for keyboard-driven CJK input — got nothing and concluded they were
    // forced to pick a listed option first.
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'picker_combo');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Type into the input and press Enter from there — no option click,
    // no Submit-button click.
    const input = panel.locator('.picker-other-input');
    await input.fill('typed via enter');
    await input.press('Enter');

    await expect(page.locator('.agent-messages:visible')).toContainText(
      'picker_answers:["typed via enter"]',
      { timeout: 5_000 },
    );
  });

  test('cancel picker: Esc dismisses and echoes cancelled', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'picker_single');

    // `:visible` scoping — worker-scoped Electron carries prior tests'
    // agent-views in inactive projects; we only target the active one.
    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    await expect(page.locator('.agent-messages:visible')).toContainText('picker_answers:cancelled', { timeout: 5_000 });
  });

  test('free-text-only picker: type answer and submit', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'picker_input');

    // `:visible` scoping — worker-scoped Electron carries prior tests'
    // agent-views in inactive projects; we only target the active one.
    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // No options rendered — input is the only path.
    await expect(panel.locator('.picker-option')).toHaveCount(0);

    await panel.locator('.picker-other-input').fill('hello world');
    await panel.locator('.picker-btn-primary').click();

    await expect(page.locator('.agent-messages:visible')).toContainText('picker_answers:["hello world"]', { timeout: 5_000 });
  });
});
