import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Agent rendering flows beyond picker — exercises every other major wire
 * event the renderer must handle: permission_request, streaming chunks
 * pairing with finalize, fold cards (tool success + error), error events,
 * auth_required pane, and stop mid-execution.
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
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
}

test.describe('agent flows via fake provider', () => {
  test.describe('provider-native permission controls', () => {
    test.use({ nativePermissions: true });

    test('shows and mutates mode and permission independently', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      const mode = page.locator('[data-config-key="nativeMode"]:visible');
      const permission = page.locator('[data-config-key="nativePermission"]:visible');
      await expect(mode).toHaveText('Mode: Agent');
      await expect(permission).toHaveText('Allow all: Off');

      await mode.click();
      await expect(page.locator('.agent-permission-header:visible')).toHaveText('Select Mode');
      await page.locator('.agent-perm-option:visible', { hasText: 'Plan' }).click();
      await expect(mode).toHaveText('Mode: Plan', { timeout: 5_000 });
      await expect(permission).toHaveText('Allow all: Off');

      await permission.click();
      await expect(page.locator('.agent-permission-header:visible')).toHaveText('Select Allow all');
      await page.locator('.agent-perm-option:visible', { hasText: 'On' }).click();
      await expect(permission).toHaveText('Allow all: On', { timeout: 5_000 });
      await expect(mode).toHaveText('Mode: Plan');
    });
  });

  test.describe('add-tab menu', () => {
    test('lists every provider from the single-source registry', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await page.locator('.tab-add').click({ button: 'right' });
      const menu = page.locator('.context-menu');
      await expect(menu).toBeVisible({ timeout: 5_000 });
      // One button per registry entry. Post-cutover: `copilot` IS the ACP backend
      // (no separate "Copilot ACP · dev" entry).
      for (const label of ['Agent (Claude)', 'Agent (Copilot)', 'Agent (Codex)', 'Agent (Test Agent)']) {
        await expect(menu.locator('.context-menu-item', { hasText: label })).toBeVisible();
      }
      await expect(menu.locator('.context-menu-item', { hasText: 'Copilot ACP' })).toHaveCount(0);
    });

    test('renders an internal provider name outside assistant replies', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await page.locator('.tab-add').click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Agent (Test Agent)' }).click();

      await expect(page.locator('.tab-bar .tab', { hasText: 'Test Agent' })).toBeVisible();
      await expect(page.locator('.agent-status-bar:visible')).toContainText('Test Agent');

      await sendAgentPrompt(page, 'text:label-source');
      await expect(page.locator('.agent-msg-reply:visible').last().locator('.agent-msg-label'))
        .toHaveCount(0);
    });
  });

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

      // Status should drop to idle after the execution completes.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    });

    test('completion summary renders as a normal assistant reply, not a task note', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await page.locator('.tab-add').click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
      await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });
      await sendAgentPrompt(page, 'completion:final completion summary');

      const reply = page.locator('.agent-msg-reply:visible', { hasText: 'final completion summary' });
      await expect(reply).toBeVisible({ timeout: 5_000 });
      await expect(reply.locator('.agent-msg-label')).toHaveCount(0);
      await expect(page.locator('.agent-msg-note:visible', { hasText: 'final completion summary' })).toHaveCount(0);
    });

    test('late chunks upsert one persisted history row', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // Default save throttle is 5s: the base snapshot persists first, then the
      // same msgId receives a late append and must update that row on its next save.
      await sendAgentPrompt(page, 'late_append:6000:early-content:late-content');
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
      await expect(page.locator('.agent-msg-reply:visible', { hasText: 'early-content' })).toHaveCount(1);
      await page.waitForTimeout(12_000);
      await expect(page.locator('.agent-msg-reply:visible', { hasText: 'early-contentlate-content' })).toHaveCount(1);

      // Inspect the renderer-owned persistence boundary directly. A page reload
      // intentionally disconnects the ephemeral E2E project/tab, so it cannot
      // exercise hydration of this same session. The storage rows are the exact
      // write-side contract under regression here.
      const persisted = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('shelf-agent-history', 4);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rows = await new Promise<any[]>((resolve, reject) => {
          const request = db.transaction('messages', 'readonly').objectStore('messages').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return rows.filter((row) => row.type === 'reply' && row.content.includes('early-content'));
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0].content).toBe('early-contentlate-content');
    });

    // Regression: providers piggyback mid-execution usage/quota on `state:'streaming'`
    // status events (copilot: rateLimits / contextUsage). The queued-cancel fix
    // (agent-core#10) must strip `state` only on the TERMINAL idle — dropping
    // streaming-status metrics wholesale blanks the status-bar quota.
    test('mid-execution streaming usage/quota reaches the status bar', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // `usage` emits a streaming status with contextUsage + rateLimits, then the
      // execution produces its reply. Segments are sticky, so they persist post-execution.
      await sendAgentPrompt(page, 'usage|text:done');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('done', { timeout: 5_000 });

      const statusBar = page.locator('.agent-status-bar:visible');
      await expect(statusBar).toContainText('ctx: 42%', { timeout: 5_000 });
      await expect(statusBar).toContainText('quota: 7%', { timeout: 5_000 });
    });

    // Account-level credit (copilot premium requests) is fetched AFTER the execution
    // via backend.refreshAccountStatus and delivered executionId-less through the
    // session sink — not on the execution's status. Proves the full post-execution path
    // (fire-and-forget refresh → session-scoped status → status bar). agent-providers#26.
    test('post-execution account credit reaches the status bar', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'credit');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('credit armed', { timeout: 5_000 });

      const statusBar = page.locator('.agent-status-bar:visible');
      await expect(statusBar).toContainText('premium: 3/10 (30%)', { timeout: 5_000 });
    });

    // Regression: copilot ACP boundary-split makes one reply per tool boundary,
    // each a chunk-only segment that settles only at execution-end idle. The streaming
    // caret (`.agent-cursor`) must live on ONLY the live segment — earlier ones
    // must settle when the next starts, not blink until idle. See agent-providers#27.
    test('boundary-split: only the live segment shows a streaming caret', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // Two chunk-only segments split by a tool, then a trailing delay so the execution
      // is STILL streaming when we assert (the bug is a mid-execution state).
      await sendAgentPrompt(page, 'chunk:first-answer|tool:Read|chunk:second-answer|delay:2000');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('second-answer', { timeout: 5_000 });
      // Both segments are on screen and the execution is mid-stream → exactly ONE caret.
      await expect(page.locator('.agent-cursor:visible')).toHaveCount(1, { timeout: 2_000 });

      // After idle, no caret remains anywhere.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
      await expect(page.locator('.agent-cursor:visible')).toHaveCount(0, { timeout: 5_000 });
    });

    test('content arriving after idle stays settled and visible', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'late_chunk:300:late tail');

      // The query settles before the scheduled provider notification.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
      await expect(page.locator('.agent-messages:visible')).toContainText('late tail', { timeout: 5_000 });
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
      await expect(page.locator('.agent-cursor:visible')).toHaveCount(0);
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

  test('Clear History removes the rendered timeline and leaves the agent usable', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'text:before clear|tool:Read');

    const messages = page.locator('.agent-messages:visible');
    await expect(messages).toContainText('before clear', { timeout: 5_000 });
    await expect(messages.locator('.fold-label', { hasText: 'Read' })).toBeVisible();
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });

    await page.locator('.agent-reset-btn:visible', { hasText: 'Clear History' }).click();
    await expect(messages.locator('.agent-msg')).toHaveCount(0);
    await expect(messages.locator('.agent-empty')).toHaveText('Send a message to start');

    await sendAgentPrompt(page, 'text:after clear');
    await expect(messages).toContainText('after clear', { timeout: 5_000 });
    await expect(messages).not.toContainText('before clear');
  });

  test('auth_required swaps the view for the auth pane', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    // The entire agent view flips to the auth pane on auth_required.
    await expect(page.locator('.agent-auth-pane:visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.agent-auth-title:visible')).toHaveText('Fake Harness not authenticated');
    // OAuth pane renders the method's fallback hints under the login button
    // (Copilot uses this to point headless remotes at a token env var).
    await expect(page.locator('.agent-auth-hints:visible')).toBeVisible();
  });

  test('interactive login: button → device code → cancel → back to button', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });

    // oauth method → interactive Login button (start_login round-trip). Copy is
    // provider-agnostic ("Log in") — GitHub is Copilot-specific and wrong for codex.
    const loginBtn = pane.locator('.agent-reset-btn', { hasText: 'Log in' });
    await expect(loginBtn).toBeVisible({ timeout: 5_000 });
    await loginBtn.click();

    // auth_login_prompt flowed back → device code + waiting state shown.
    await expect(pane.locator('.agent-auth-code')).toHaveText('FAKE-CODE', { timeout: 5_000 });
    await expect(pane.locator('.agent-auth-waiting')).toBeVisible();
    // The prefilled URL is always surfaced as a clickable link (opens the system
    // browser via setWindowOpenHandler), regardless of auto-open.
    await expect(pane.locator('a.agent-auth-link')).toHaveAttribute('href', 'https://github.com/login/device?user_code=FAKE-CODE');

    // Cancel → cancel_login → auth_login_done{cancelled} → back to the button.
    await pane.locator('.agent-reset-btn', { hasText: 'Cancel' }).click();
    await expect(pane.locator('.agent-auth-code')).toHaveCount(0, { timeout: 5_000 });
    await expect(pane.locator('.agent-reset-btn', { hasText: 'Log in' })).toBeVisible();
  });

  test.describe('interactive login succeeds', () => {
    test.use({ loginSuccess: true });

    test('clears auth and init overlays and leaves the originating pane usable', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'auth_required');

      const pane = page.locator('.agent-auth-pane:visible');
      await expect(pane).toBeVisible({ timeout: 5_000 });
      await pane.locator('.agent-reset-btn', { hasText: 'Log in' }).click();

      await expect(page.locator('.agent-auth-pane:visible')).toHaveCount(0, { timeout: 5_000 });
      await expect(page.locator('.agent-conn-overlay')).toHaveCount(0, { timeout: 5_000 });
      const ta = page.locator('.agent-textarea:visible');
      await expect(ta).toBeEnabled();
      await ta.fill('/model');
      await ta.press('Enter');
      await expect(page.locator('.agent-permission:visible')).toContainText('fake-model-after-auth');
    });
  });

  test('manual auth Retry stays phase-silent and publishes fresh capabilities', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await pane.locator('.agent-reset-btn', { hasText: 'Retry' }).click();

    await expect(page.locator('.agent-auth-pane:visible')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('.agent-conn-overlay')).toHaveCount(0, { timeout: 5_000 });
    const ta = page.locator('.agent-textarea:visible');
    await expect(ta).toBeEnabled();
    await ta.fill('/model');
    await ta.press('Enter');
    await expect(page.locator('.agent-permission:visible')).toContainText('fake-model-after-auth');
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
    // appear and the execution should settle to idle.
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

  test('stop via double-Esc cancels mid-execution picker', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // delay:5000 keeps the execution open in case picker resolves fast on its own;
    // we hit Esc to abort once the panel is visible.
    await sendAgentPrompt(page, 'picker_single|delay:5000');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // First Esc dismisses the picker (cancelled payload echoed back).
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    // Then the execution is still running due to `delay:5000` — second Esc twice
    // hits the stop affordance ("Press Esc again to stop").
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Status returns to idle after stop().
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
  });

  test('Copilot double-Esc stops late work even after the prompt reports idle', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
    await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

    await sendAgentPrompt(page, 'late_chunk:1500:must-not-arrive');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.waitForTimeout(2_000);
    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'must-not-arrive' })).toHaveCount(0);
  });

  test('typing between Escape presses does not stop idle Copilot work', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
    await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

    await sendAgentPrompt(page, 'late_chunk:1500:copilot-still-running');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    const input = page.locator('.agent-textarea:visible');
    await input.focus();
    await page.keyboard.press('Escape');
    await input.pressSequentially('draft text');
    await page.keyboard.press('Escape');

    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'copilot-still-running' })).toBeVisible({ timeout: 3_000 });
    await expect(input).toHaveValue('draft text');
  });

  test('Codex double-Esc stops late work even after the turn reports idle', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Codex)' }).click();
    await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

    await sendAgentPrompt(page, 'late_chunk:1500:codex-must-not-arrive');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.waitForTimeout(2_000);
    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'codex-must-not-arrive' })).toHaveCount(0);
  });

  test.describe('queued messages', () => {
    // Messages submitted while a execution streams are EAGER-sent (each with a
    // clientMsgId) and queued by agent-server, which serializes them one execution at
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

      // T1 holds the execution open so T2/T3 are submitted while streaming → enqueued.
      await sendAgentPrompt(page, 'delay:1500|text:T1');
      await expect(page.locator('.agent-loading')).toBeVisible({ timeout: 5_000 });
      await sendAgentPrompt(page, 'delay:300|text:T2');
      await sendAgentPrompt(page, 'delay:300|text:T3');

      // All three executions flush through the queue and produce their output, and the
      // queue ends empty.
      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('T1', { timeout: 10_000 });
      await expect(messages).toContainText('T2', { timeout: 10_000 });
      await expect(messages).toContainText('T3', { timeout: 10_000 });
      await expect(page.locator('.agent-msg-queued')).toHaveCount(0, { timeout: 10_000 });
    });

    // Regression: cancelling a QUEUED send must not disturb the RUNNING execution's
    // status. agent-server emits a bare `idle` on the cancelled send's executionId
    // (to release its per-execution generator); that per-execution idle must NOT flip the
    // tab-wide streaming flag to idle while a foreground execution is still running
    // (session idle is owned by main's activeExecutions, emitted only when the LAST
    // execution ends). Before the fix, cancelling the chip cleared the spinner mid-run.
    test('cancelling a queued send leaves the running execution streaming', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // T1 holds the execution open (long delay, no text yet → spinner stays up).
      await sendAgentPrompt(page, 'delay:4000|text:T1');
      await expect(page.locator('.agent-loading')).toBeVisible({ timeout: 5_000 });

      // T2 is submitted while T1 streams → enqueued as a chip.
      await sendAgentPrompt(page, 'text:T2');
      const queued = page.locator('.agent-msg-queued');
      await expect(queued).toHaveCount(1, { timeout: 5_000 });

      // Cancel the queued chip. Its terminateExecution idle must not clear the spinner.
      await queued.locator('.agent-queued-cancel').click();
      await expect(queued).toHaveCount(0, { timeout: 5_000 });

      // The running execution (T1) is still going: spinner stays visible. Wait past the
      // cancel's IPC round-trip so the (previously bug-inducing) idle has arrived.
      await expect(page.locator('.agent-loading')).toBeVisible();
      await page.waitForTimeout(1000);
      await expect(page.locator('.agent-loading')).toBeVisible();

      // T1 still completes normally; T2 was cancelled and never runs.
      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('T1', { timeout: 10_000 });
      await expect(page.locator('.agent-loading')).toHaveCount(0, { timeout: 5_000 });
      await expect(messages).not.toContainText('T2');
    });
  });

  // Agent tabs are plain DOM (no xterm SearchAddon), so the SearchBar routes
  // through Chromium's native findInPage via IPC and shows a match counter.
  // Covers the wiring a unit test can't reach: SearchBar → window:find →
  // main forwarder → window:find-result → counter render.
  //
  // Harness note: NODE_ENV=test launches the window hidden (show:false), and a
  // hidden window doesn't emit 'found-in-page' for the fire-and-forget find the
  // keystroke issues. The find request still binds the main forwarder; we then
  // nudge Chromium to actually emit by showing the window inactively and
  // re-issuing the *same* find from main. Our bound forwarder relays that event
  // to the renderer exactly as it would in a real, visible window — so this
  // asserts our relay + counter, not Chromium's emission (which isn't our code).
  test.describe('in-page search', () => {
    const emit = (app: import('@playwright/test').ElectronApplication, text: string) =>
      app.evaluate(({ BrowserWindow }, t) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.showInactive();
        win.webContents.findInPage(t);
      }, text);

    test('finds conversation text and shows a match count', async ({ shelfApp: { app, page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // 'zumwaltberry' renders in the DOM (user echo bubble + agent reply).
      await sendAgentPrompt(page, 'text:zumwaltberry');
      await expect(page.locator('.agent-messages:visible')).toContainText('zumwaltberry', { timeout: 5_000 });

      // mod+f opens the find bar (default 'search' keybinding).
      await page.keyboard.press(`${modifier}+f`);
      const bar = page.locator('.search-bar');
      await expect(bar).toBeVisible({ timeout: 3_000 });

      // Type → routes through findInPage IPC (agent tab, no xterm addon) and
      // binds the main forwarder. Then nudge the emission.
      await bar.locator('.search-input').fill('zumwaltberry');
      await emit(app, 'zumwaltberry');
      // Counter shows "<active>/<total>" with a non-zero total — proves the full
      // relay: SearchBar → window:find → main forwarder → window:find-result →
      // counter render.
      await expect(page.locator('.search-count')).toHaveText(/^\d+\/[1-9]\d*$/, { timeout: 5_000 });

      // Close button hides the bar (× avoids depending on input focus, which
      // the find-nudge above moves).
      await bar.locator('.search-btn', { hasText: '×' }).click();
      await expect(bar).not.toBeVisible({ timeout: 3_000 });
    });
  });

  // /mcp and /skills are interactive-TUI-only in the real CLIs (not SDK-
  // dispatchable), so the provider intercepts them and prints a read-only
  // fold_markdown card from normalized data. The fake provider mirrors this with
  // canned data. Covers the slash → intercept → card wiring (the format itself
  // is unit-tested in loaded-context.test.ts).
  test.describe('loaded MCP / skills listings', () => {
    // Rendered as a plain agent reply (full-width markdown table), NOT a fold
    // card — so the result is a `<table>` directly in the timeline.
    test('/mcp prints a full-width table of MCP servers + status', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, '/mcp');
      const table = page.locator('.agent-messages:visible table').last();
      await expect(table).toBeVisible({ timeout: 5_000 });
      await expect(table).toContainText('fake-fs');
      await expect(table).toContainText('connected');
      await expect(table).toContainText('fake-db');
      await expect(table).toContainText('down'); // failed server's error
      // Not wrapped in a fold/tool card.
      await expect(page.locator('.agent-msg-fold:has(.fold-label:has-text("/mcp"))')).toHaveCount(0);
    });

    test('/skills prints a full-width table of skills + source', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, '/skills');
      const table = page.locator('.agent-messages:visible table').last();
      await expect(table).toBeVisible({ timeout: 5_000 });
      await expect(table).toContainText('fake-skill');
      await expect(table).toContainText('app'); // normalized source tag
    });
  });

  // Long slash lists (e.g. ACP's 32 commands) overflow the menu's max-height
  // scroll. The dropdown must render ALL matches (not a hard cap) and keep the
  // keyboard-selected row scrolled into view. See SlashMenu.
  test('slash menu renders all commands and scrolls the selection into view', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    const ta = page.locator('.agent-textarea:visible');
    await ta.click();
    await ta.type('/');

    const menu = page.locator('.agent-slash-menu:visible');
    await expect(menu).toBeVisible();
    const items = menu.locator('.agent-slash-item');
    const count = await items.count();
    // Regression: the old `.slice(0, 10)` capped rendering — a long list must
    // render every entry so the tail is reachable at all.
    expect(count).toBeGreaterThan(10);

    // Arrow to the LAST entry — past the visible fold. (Order is provider list +
    // renderer-local commands, so don't assume which name is last — assert by
    // position instead.)
    for (let i = 0; i < count - 1; i++) await ta.press('ArrowDown');
    await expect(items.last()).toHaveClass(/agent-slash-item-selected/);
    // Regression: without scroll-into-view the menu stays at scrollTop 0 and the
    // selected tail row is clipped out of the scroll viewport.
    const scrollTop = await menu.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
  });
});
