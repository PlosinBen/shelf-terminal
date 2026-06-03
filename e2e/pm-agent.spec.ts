import { test, expect } from './helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// Helper: open PM panel via footer toggle
async function openPmPanel(page: any) {
  const panel = page.locator('.pm-panel');
  if (await panel.isVisible().catch(() => false)) return;
  const pmBtn = page.locator('.right-tab-btn', { hasText: 'PM' });
  await expect(pmBtn).toBeVisible({ timeout: 5_000 });
  await pmBtn.click();
  await expect(panel).toBeVisible({ timeout: 3_000 });
}

// Helper: close PM panel
async function closePmPanel(page: any) {
  const panel = page.locator('.pm-panel');
  if (!await panel.isVisible().catch(() => false)) return;
  await page.locator('.pm-header-btn', { hasText: '×' }).click();
  await expect(panel).not.toBeVisible({ timeout: 3_000 });
}

// Helper: configure PM provider via Settings panel
async function configurePmProvider(page: any) {
  await page.keyboard.press(`${modifier}+,`);
  const settingsPanel = page.locator('.settings-panel');
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 });

  // Click PM Agent tab
  await page.locator('.settings-tab', { hasText: 'PM Agent' }).click();

  // Fill provider fields
  const body = page.locator('.settings-body');
  const inputs = body.locator('.settings-input');
  await inputs.nth(0).selectOption('openai');
  await inputs.nth(1).fill('test-key-123');
  await inputs.nth(2).selectOption({ index: 1 });

  // Save
  await page.locator('.conn-btn-next').click();
  await expect(settingsPanel).not.toBeVisible({ timeout: 3_000 });
}

// ── Footer toggle ──

test('footer shows PM toggle', async ({ shelfApp: { page } }) => {
  const pmBtn = page.locator('.right-tab-btn', { hasText: 'PM' });
  await expect(pmBtn).toBeVisible({ timeout: 5_000 });
});

test('PM footer toggle has status dot', async ({ shelfApp: { page } }) => {
  const dot = page.locator('.right-tab-btn .pm-tab-dot');
  await expect(dot).toBeVisible({ timeout: 5_000 });
});

test('footer shows DevTools toggle alongside PM', async ({ shelfApp: { page } }) => {
  const devToolsBtn = page.locator('.right-tab-btn', { hasText: 'Dev Tools' });
  await expect(devToolsBtn).toBeVisible({ timeout: 5_000 });
});

// ── PM Panel ──

test('clicking PM tab opens panel', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);

  // Terminal section should still be visible (panel, not page)
  await expect(page.locator('.terminal-section')).toBeVisible();
});

test('PM panel has header with title', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);
  await expect(page.locator('.pm-header-title')).toContainText('PM');
});

test('closing PM panel shows footer toggle again', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);
  await closePmPanel(page);

  const pmBtn = page.locator('.right-tab-btn', { hasText: 'PM' });
  await expect(pmBtn).toBeVisible({ timeout: 3_000 });
});

test('PM panel shows no-provider message before configuration', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);
  const noProvider = page.locator('.pm-no-provider');
  await expect(noProvider).toBeVisible({ timeout: 3_000 });
  await expect(noProvider).toContainText('Settings');
  await closePmPanel(page);
});

// ── Settings: PM Agent tab ──

test('settings panel has PM Agent tab', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const settingsPanel = page.locator('.settings-panel');
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 });

  const pmTab = page.locator('.settings-tab', { hasText: 'PM Agent' });
  await expect(pmTab).toBeVisible();

  await pmTab.click();

  // Should show provider fields
  await expect(page.locator('.settings-section-title', { hasText: 'Provider' })).toBeVisible();
  await expect(page.locator('.settings-section-title', { hasText: 'Telegram' })).toBeVisible();

  await page.keyboard.press('Escape');
});

test('PM provider can be configured via Settings', async ({ shelfApp: { page } }) => {
  await configurePmProvider(page);

  // Open PM panel — should show chat UI, not no-provider message
  await openPmPanel(page);
  await expect(page.locator('.pm-no-provider')).not.toBeVisible();
  await expect(page.locator('.pm-input')).toBeVisible();
  await expect(page.locator('.pm-send-btn')).toBeVisible();
  await closePmPanel(page);
});

// ── Away Mode UI ──

test('Away Mode toggle exists in PM panel header', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);
  const toggle = page.locator('.pm-away-toggle');
  await expect(toggle).toBeVisible({ timeout: 3_000 });
  await expect(toggle).toContainText('Away OFF');
  await closePmPanel(page);
});

test('Away Mode toggle changes button state and dot color', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);
  const toggle = page.locator('.pm-away-toggle');
  await expect(toggle).toContainText('Away OFF');

  // Toggle ON
  await toggle.click();
  await expect(toggle).toContainText('Away ON', { timeout: 3_000 });
  await expect(toggle).toHaveClass(/pm-away-on/);

  // Toggle OFF
  await toggle.click();
  await expect(toggle).toContainText('Away OFF', { timeout: 3_000 });
  await closePmPanel(page);
});

test('Away Mode overlay shows on terminal', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);
  const toggle = page.locator('.pm-away-toggle');

  // Turn ON
  await toggle.click();
  await expect(toggle).toContainText('Away ON', { timeout: 3_000 });

  // Overlay should be visible on terminal section
  const overlay = page.locator('.away-mode-overlay');
  await expect(overlay).toBeVisible({ timeout: 3_000 });
  await expect(overlay).toContainText('Away Mode');

  // Turn OFF for cleanup
  await toggle.click();
  await expect(toggle).toContainText('Away OFF', { timeout: 3_000 });
  await closePmPanel(page);
});

// ── Clear Conversation ──

test('PM clear button exists', async ({ shelfApp: { page } }) => {
  await openPmPanel(page);
  const clearBtn = page.locator('.pm-header-btn', { hasText: 'Clear' });
  await expect(clearBtn).toBeVisible({ timeout: 3_000 });
  await closePmPanel(page);
});
