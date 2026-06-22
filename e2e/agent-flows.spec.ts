import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Agent rendering flows beyond picker — exercises every other major wire
 * event the renderer must handle: permission_request, streaming chunks
 * pairing with finalize, fold cards (tool success + error), error events,
 * auth_required pane, and stop mid-turn.
 *
 * All driven via the fake provider (SHELF_TEST_MODE=1, see helpers.ts).
 * Scenarios documented in `agent-server/providers/fake.ts`.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  // setStep('browse') is synchronous but FolderPicker.tsx then kicks off an
  // async requestFolder → listDir. On slower hosts (Linux Electron, CI)
  // Cmd+Enter can fire before listDir lands → currentPath is still '' →
  // handleSelect falls back to the literal "project" name and an empty cwd →
  // agent-server later rejects sends with "Missing prompt or cwd". Wait for
  // the resolved path to populate before confirming.
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

test.describe('agent flows via fake provider', () => {
  test.describe('permission', () => {
    test('Allow once → tool runs, success system message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'permission:Bash');

      const panel = page.locator('.agent-permission:visible');
      await expect(panel).toBeVisible({ timeout: 5_000 });
      await expect(panel).toContainText('Bash');

      await panel.locator('.agent-perm-option', { hasText: 'Allow once' }).click();
      await expect(page.locator('.agent-messages:visible')).toContainText('permission allowed: Bash', { timeout: 5_000 });
    });

    test('Deny → deny system message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'permission:Write');

      const panel = page.locator('.agent-permission:visible');
      await expect(panel).toBeVisible({ timeout: 5_000 });
      await panel.locator('.agent-perm-option', { hasText: 'Deny' }).click();

      await expect(page.locator('.agent-messages:visible')).toContainText('permission denied: Write', { timeout: 5_000 });
    });
  });

  test.describe('streaming', () => {
    test('text stream chunks finalize into a single message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // Two stream chunks → one finalize. After settling we expect the
      // finalized message present with the full content (upsert behavior:
      // chunks share msgId with finalize, no duplication).
      await sendAgentPrompt(page, 'text:hello world');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('hello world', { timeout: 5_000 });

      // Status should drop to idle after the turn completes.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    });
  });

  test.describe('fold (tool_use)', () => {
    test('tool: renders a fold card with the tool name and ok result', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'tool:Read');

      // Tool results render as fold cards. Body is hidden when collapsed
      // (fold_code defaults to collapsed), so match by header label instead.
      const toolCard = page.locator('.agent-msg-fold:has(.fold-label:has-text("Read")):visible').last();
      await expect(toolCard).toBeVisible({ timeout: 5_000 });
      await expect(toolCard.locator('.fold-label')).toHaveText('Read');
    });

    test('tool_err: shows error banner on failed fold card', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'tool_err:Bash');

      const toolCard = page.locator('.agent-msg-fold:has(.fold-error-banner):visible').last();
      await expect(toolCard).toBeVisible({ timeout: 5_000 });
      await expect(toolCard.locator('.fold-label')).toHaveText('Bash');
      // Failed fold cards force-expand; error banner is visible without clicking.
      await expect(toolCard.locator('.fold-error-banner')).toBeVisible();
    });
  });

  test('auth_required swaps the view for the auth pane', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    // The entire agent view flips to the auth pane on auth_required.
    await expect(page.locator('.agent-auth-pane:visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.agent-auth-title:visible')).toContainText('Fake');
  });

  test('thinking: renders as a fold_text card', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'thinking:considering options');

    // Thinking maps to fold_text with label "Thinking". Body is collapsed by
    // default — match by header label, then click to expand and verify content.
    const card = page.locator('.agent-msg-fold:has(.fold-label:has-text("Thinking")):visible').last();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.locator('.fold-header').click();
    await expect(card.locator('.fold-body-text')).toContainText('considering options');
  });

  test('picker_number: integer-only input flow', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'picker_number');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // No option list — only the numeric input.
    await expect(panel.locator('.picker-option')).toHaveCount(0);
    // input[type=number] is the rendered control for integer inputType.
    const input = panel.locator('.picker-other-input');
    await expect(input).toHaveAttribute('type', 'number');

    await input.fill('42');
    await panel.locator('.picker-btn-primary').click();

    await expect(page.locator('.agent-messages:visible')).toContainText('picker_answers:["42"]', { timeout: 5_000 });
  });

  test('chain: scenarios run in order and produce all messages', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // Two text + one tool, separated by a tiny delay. All three should
    // appear and the turn should settle to idle.
    await sendAgentPrompt(page, 'text:hello|delay:30|tool:Read|text:bye');

    const messages = page.locator('.agent-messages:visible');
    await expect(messages).toContainText('hello', { timeout: 5_000 });
    await expect(messages).toContainText('bye');
    await expect(messages.locator('.fold-label', { hasText: 'Read' })).toBeVisible();
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
  });

  test('unknown prompt: fake-echo fallback renders as text', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // Anything that doesn't prefix-match a known scenario falls back to
    // an echo so dev-mode pokes still produce visible output.
    await sendAgentPrompt(page, 'totally unknown scenario');

    await expect(page.locator('.agent-messages:visible'))
      .toContainText('fake-echo: totally unknown scenario', { timeout: 5_000 });
  });

  test('error event renders as an error message', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'error:something broke');

    const err = page.locator('.agent-msg-error:visible').last();
    await expect(err).toBeVisible({ timeout: 5_000 });
    await expect(err).toContainText('something broke');
  });

  test('stop via double-Esc cancels mid-turn picker', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // delay:5000 keeps the turn open in case picker resolves fast on its own;
    // we hit Esc to abort once the panel is visible.
    await sendAgentPrompt(page, 'picker_single|delay:5000');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // First Esc dismisses the picker (cancelled payload echoed back).
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    // Then the turn is still running due to `delay:5000` — second Esc twice
    // hits the stop affordance ("Press Esc again to stop").
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Status returns to idle after stop().
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
  });

  test.describe('queued messages', () => {
    // Messages submitted while a turn streams are EAGER-sent (each with a
    // clientMsgId) and queued by agent-server, which serializes them one turn at
    // a time and emits a queue snapshot the renderer mirrors as chips. This e2e
    // covers the WIRING a unit test can't: every queued send actually drains
    // through IPC → agent-server → provider and runs in order.
    // The reconcile + queue logic itself is unit-tested deterministically
    // (queue-reconcile.test.ts, send-queue.test.ts).
    //
    // We deliberately DON'T assert the transient `.agent-msg-queued` count
    // (2→1→0): that intermediate state is timing-sensitive and was flaky on slow
    // e2e hosts (e.g. WSL2) for no added coverage. Asserting the final outcome
    // (all three ran, queue drained) is robust.
    test('queued messages all flush through and run', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // T1 holds the turn open so T2/T3 are submitted while streaming → enqueued.
      await sendAgentPrompt(page, 'delay:1500|text:T1');
      await expect(page.locator('.agent-loading')).toBeVisible({ timeout: 5_000 });
      await sendAgentPrompt(page, 'delay:300|text:T2');
      await sendAgentPrompt(page, 'delay:300|text:T3');

      // All three turns flush through the queue and produce their output, and the
      // queue ends empty.
      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('T1', { timeout: 10_000 });
      await expect(messages).toContainText('T2', { timeout: 10_000 });
      await expect(messages).toContainText('T3', { timeout: 10_000 });
      await expect(page.locator('.agent-msg-queued')).toHaveCount(0, { timeout: 10_000 });
    });
  });

  // /mcp and /skills are interactive-TUI-only in the real CLIs (not SDK-
  // dispatchable), so the provider intercepts them and prints a read-only
  // fold_markdown card from normalized data. The fake provider mirrors this with
  // canned data. Covers the slash → intercept → card wiring (the format itself
  // is unit-tested in loaded-context.test.ts).
  test.describe('loaded MCP / skills listings', () => {
    // Expand the fold card if collapsed (default depends on a display setting),
    // then assert its body content.
    async function expandedBody(page: import('@playwright/test').Page, label: string) {
      const card = page.locator(`.agent-msg-fold:has(.fold-label:has-text("${label}")):visible`).last();
      await expect(card).toBeVisible({ timeout: 5_000 });
      const body = card.locator('.fold-body-markdown');
      if (!(await body.isVisible().catch(() => false))) {
        await card.locator('.fold-header').click();
      }
      return body;
    }

    test('/mcp prints a card listing MCP servers + status', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, '/mcp');
      const body = await expandedBody(page, '/mcp');
      // Renders as a GFM table (not raw markdown / a bullet list).
      await expect(body.locator('table')).toBeVisible();
      await expect(body).toContainText('fake-fs');
      await expect(body).toContainText('connected');
      await expect(body).toContainText('fake-db');
      await expect(body).toContainText('down'); // failed server's error
    });

    test('/skills prints a card listing skills + source', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, '/skills');
      const body = await expandedBody(page, '/skills');
      await expect(body.locator('table')).toBeVisible(); // GFM table
      await expect(body).toContainText('fake-skill');
      await expect(body).toContainText('app'); // normalized source tag
    });
  });
});
