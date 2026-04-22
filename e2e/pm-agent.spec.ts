import { test, expect } from './helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// ── PM Entry in Sidebar ──

test('sidebar shows PM entry above project list', async ({ shelfApp: { page } }) => {
  const pmEntry = page.locator('.sidebar-pm-entry');
  await expect(pmEntry).toBeVisible({ timeout: 5_000 });
  await expect(pmEntry).toContainText('PM');
});

test('PM entry has green status dot by default (Away Mode OFF)', async ({ shelfApp: { page } }) => {
  const dot = page.locator('.sidebar-pm-entry .pm-dot');
  await expect(dot).toBeVisible();
});

// ── PmView ──

test('clicking PM entry shows PmView', async ({ shelfApp: { page } }) => {
  await page.locator('.sidebar-pm-entry').click();

  const pmView = page.locator('.pm-view');
  await expect(pmView).toBeVisible({ timeout: 3_000 });

  // Terminal section should be hidden
  const terminalSection = page.locator('.terminal-section');
  await expect(terminalSection).not.toBeVisible();
});

test('PmView shows provider settings when no provider configured', async ({ shelfApp: { page } }) => {
  await page.locator('.sidebar-pm-entry').click();

  // Should show settings form since no provider is configured
  const settingsForm = page.locator('.pm-settings-form');
  await expect(settingsForm).toBeVisible({ timeout: 3_000 });

  // Verify form fields exist
  await expect(page.locator('.pm-settings-input').first()).toBeVisible();
});

test('clicking project switches back from PmView to terminal', async ({ shelfApp: { page } }) => {
  // Ensure no overlay is open
  const overlay = page.locator('.folder-picker-overlay');
  if (await overlay.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  }

  // Create a project if none exist
  if (await page.locator('.sidebar-list .sidebar-item').count() === 0) {
    // Make sure PmView is not shown (its settings form has conn-btn-next too)
    const pmView = page.locator('.pm-view');
    if (await pmView.isVisible().catch(() => false)) {
      // Click the PM entry to dismiss any settings form focus, then close
      // We need to leave PmView — but no project to click yet. Just proceed,
      // folder-picker overlay renders on top.
    }

    await page.locator('.sidebar-btn', { hasText: '+' }).click();
    await expect(overlay).toBeVisible({ timeout: 5_000 });

    // Connection step — target the button inside the folder picker
    const nextBtn = overlay.locator('.conn-btn-next');
    await expect(nextBtn).toBeVisible({ timeout: 3_000 });
    await nextBtn.click();
    await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });

    await page.keyboard.press(`${modifier}+Enter`);
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  }

  // Switch to PM
  await page.locator('.sidebar-pm-entry').click();
  await expect(page.locator('.pm-view')).toBeVisible({ timeout: 3_000 });

  // Click a project in sidebar (not the PM entry)
  await page.locator('.sidebar-list .sidebar-item').first().click();

  // PmView should be gone, terminal section visible
  await expect(page.locator('.pm-view')).not.toBeVisible({ timeout: 3_000 });
  await expect(page.locator('.terminal-section')).toBeVisible();
});

// ── Provider Settings ──

test('PmView provider settings can be filled and saved', async ({ shelfApp: { page } }) => {
  await page.locator('.sidebar-pm-entry').click();
  await expect(page.locator('.pm-settings-form')).toBeVisible({ timeout: 3_000 });

  const inputs = page.locator('.pm-settings-input');

  // Fill base URL
  await inputs.nth(0).fill('https://api.example.com/v1');
  // Fill API key
  await inputs.nth(1).fill('test-key-123');
  // Fill model
  await inputs.nth(2).fill('test-model');

  // Save button should be enabled
  const saveBtn = page.locator('.conn-btn-next');
  await expect(saveBtn).toBeEnabled();

  await saveBtn.click();

  // After saving, should show the chat UI (header with PM Agent title)
  await expect(page.locator('.pm-header-title')).toContainText('PM Agent', { timeout: 3_000 });
});

test('PmView chat UI has input area and header after provider configured', async ({ shelfApp: { page } }) => {
  // Provider was configured in previous test (same worker)
  await page.locator('.sidebar-pm-entry').click();

  const header = page.locator('.pm-header');
  await expect(header).toBeVisible({ timeout: 3_000 });

  const inputArea = page.locator('.pm-input-area');
  await expect(inputArea).toBeVisible();

  const input = page.locator('.pm-input');
  await expect(input).toBeVisible();

  const sendBtn = page.locator('.pm-send-btn');
  await expect(sendBtn).toBeVisible();
});

// ── Away Mode UI ──

test('Away Mode toggle button exists in PmView header', async ({ shelfApp: { page } }) => {
  await page.locator('.sidebar-pm-entry').click();
  // Need provider configured — if settings form shows, fill it
  const settingsForm = page.locator('.pm-settings-form');
  if (await settingsForm.isVisible({ timeout: 1_000 }).catch(() => false)) {
    const inputs = page.locator('.pm-settings-input');
    await inputs.nth(0).fill('https://api.example.com/v1');
    await inputs.nth(1).fill('test-key');
    await inputs.nth(2).fill('test-model');
    await page.locator('.conn-btn-next').click();
  }

  const toggle = page.locator('.pm-away-toggle');
  await expect(toggle).toBeVisible({ timeout: 3_000 });
  await expect(toggle).toContainText('Away OFF');
});

test('clicking Away Mode toggle changes button state', async ({ shelfApp: { page } }) => {
  await page.locator('.sidebar-pm-entry').click();

  const toggle = page.locator('.pm-away-toggle');
  if (!await toggle.isVisible({ timeout: 2_000 }).catch(() => false)) {
    // Configure provider if needed
    const inputs = page.locator('.pm-settings-input');
    await inputs.nth(0).fill('https://api.example.com/v1');
    await inputs.nth(1).fill('test-key');
    await inputs.nth(2).fill('test-model');
    await page.locator('.conn-btn-next').click();
  }

  await expect(toggle).toContainText('Away OFF');

  // Toggle ON
  await toggle.click();
  await expect(toggle).toContainText('Away ON', { timeout: 3_000 });
  await expect(toggle).toHaveClass(/pm-away-on/);

  // Sidebar dot should change to red
  const dot = page.locator('.sidebar-pm-entry .pm-dot-away');
  await expect(dot).toBeVisible();

  // Toggle OFF
  await toggle.click();
  await expect(toggle).toContainText('Away OFF', { timeout: 3_000 });
});

test('Away Mode overlay shows on terminal when Away Mode is ON', async ({ shelfApp: { page } }) => {
  // Create and connect a project
  if (await page.locator('.sidebar-item').count() === 0) {
    await page.locator('.sidebar-btn', { hasText: '+' }).click();
    await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
    await page.locator('.conn-btn-next').click();
    await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
    await page.keyboard.press(`${modifier}+Enter`);
    await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });
  }

  // Switch to PM and turn Away Mode ON
  await page.locator('.sidebar-pm-entry').click();
  const toggle = page.locator('.pm-away-toggle');
  if (!await toggle.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const inputs = page.locator('.pm-settings-input');
    await inputs.nth(0).fill('https://api.example.com/v1');
    await inputs.nth(1).fill('test-key');
    await inputs.nth(2).fill('test-model');
    await page.locator('.conn-btn-next').click();
  }

  // Ensure Away Mode is ON
  if (await toggle.textContent() === 'Away OFF') {
    await toggle.click();
    await expect(toggle).toContainText('Away ON', { timeout: 3_000 });
  }

  // Switch to project view
  await page.locator('.sidebar-item').first().click();

  // Overlay should be visible
  const overlay = page.locator('.away-mode-overlay');
  await expect(overlay).toBeVisible({ timeout: 3_000 });
  await expect(overlay).toContainText('Away Mode');

  // Turn OFF for cleanup
  await page.locator('.sidebar-pm-entry').click();
  await toggle.click();
  await expect(toggle).toContainText('Away OFF', { timeout: 3_000 });
});

// ── Settings: Telegram Fields ──

test('settings panel has Telegram section', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const settingsPanel = page.locator('.settings-panel');
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 });

  await expect(page.locator('.settings-section-title', { hasText: 'Telegram' })).toBeVisible();

  // Close settings
  await page.keyboard.press('Escape');
});

// ── Clear Conversation ──

test('PmView clear button resets messages', async ({ shelfApp: { page } }) => {
  await page.locator('.sidebar-pm-entry').click();

  const clearBtn = page.locator('.pm-header-btn', { hasText: 'Clear' });
  if (await clearBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await clearBtn.click();
    // Messages area should be empty
    const messages = page.locator('.pm-msg');
    await expect(messages).toHaveCount(0, { timeout: 3_000 });
  }
});
