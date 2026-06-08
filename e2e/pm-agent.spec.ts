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

// Helper: configure PM provider via Settings panel.
// Uses label-based group filters because input index ordering changed after
// the Base URL input was added (only appears after a provider is selected —
// see DECISIONS-pm #65).
async function configurePmProvider(page: any) {
  await page.keyboard.press(`${modifier}+,`);
  const settingsPanel = page.locator('.settings-panel');
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 });

  // Click PM Agent tab
  await page.locator('.settings-tab', { hasText: 'PM Agent' }).click();

  const body = page.locator('.settings-body');
  // Filter settings-group by the label text. hasText is case-insensitive
  // substring — works because no other group's text contains "Provider" /
  // "API Key" / "Model" as a label.
  await body.locator('.settings-group').filter({ hasText: 'Provider' }).locator('select').selectOption('openai');
  await body.locator('.settings-group').filter({ hasText: 'API Key' }).locator('input').fill('test-key-123');
  // Model select lives inside a .settings-model-row wrapper; .nth(0) picks
  // the select (the refresh button isn't a select).
  await body.locator('.settings-group')
    .filter({ has: page.locator('label.settings-label', { hasText: 'Model' }) })
    .locator('select')
    .selectOption({ index: 1 });

  // Save
  await page.locator('.conn-btn-next').click();
  await expect(settingsPanel).not.toBeVisible({ timeout: 3_000 });
}

/** Open Settings panel on PM tab. Reusable helper for the ollama / provider
 *  UI tests below. */
async function openSettingsOnPmTab(page: any) {
  await page.keyboard.press(`${modifier}+,`);
  const settingsPanel = page.locator('.settings-panel');
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 });
  await page.locator('.settings-tab', { hasText: 'PM Agent' }).click();
  await expect(page.locator('.settings-section-title', { hasText: 'Provider' })).toBeVisible();
  return settingsPanel;
}

// Helper: enable PM Active (Away requires it). Sets dummy telegram config +
// flips PM Active on via IPC. In SHELF_TEST_MODE the listener is a no-op, so
// PM Active stays on without touching the network. Opens the PM panel.
async function enablePmActive(page: any) {
  await page.evaluate(async () => {
    const api = (window as any).shelfApi;
    const s = await api.settings.load();
    await api.settings.save({ ...s, telegram: { botToken: 'test-token', chatId: '123' } });
    await api.pm.setActive(true);
  });
  await openPmPanel(page);
  await expect(page.locator('.pm-active-toggle.pm-active-on')).toBeVisible({ timeout: 3_000 });
}

// ── Footer toggle ──

test('footer shows PM toggle', async ({ shelfApp: { page } }) => {
  const pmBtn = page.locator('.right-tab-btn', { hasText: 'PM' });
  await expect(pmBtn).toBeVisible({ timeout: 5_000 });
});

test('PM footer toggle reflects away mode', async ({ shelfApp: { page } }) => {
  const pmBtn = page.locator('.right-tab-btn', { hasText: 'PM' });
  await expect(pmBtn).not.toHaveClass(/pm-away/);

  // Turn Away Mode on from the PM panel header → footer toggle goes red (pm-away)
  await enablePmActive(page);
  await page.locator('.pm-away-toggle').click();
  await expect(page.locator('.pm-away-toggle')).toContainText('Away ON', { timeout: 3_000 });
  await expect(pmBtn).toHaveClass(/pm-away/);

  // Off + cleanup
  await page.locator('.pm-away-toggle').click();
  await expect(pmBtn).not.toHaveClass(/pm-away/);
  await closePmPanel(page);
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

  // Open PM panel — should show the (read-only) conversation area, not the
  // no-provider message.
  await openPmPanel(page);
  await expect(page.locator('.pm-no-provider')).not.toBeVisible();
  await expect(page.locator('.pm-messages')).toBeVisible();
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

test('Away Mode toggle changes its on/off state', async ({ shelfApp: { page } }) => {
  await enablePmActive(page);
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
  await enablePmActive(page);
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

// ── Ollama provider UI (DECISIONS-pm #65) ──
//
// These verify the deterministic UI bits of selecting Ollama in PM Settings:
// option presence, Base URL input visibility/placeholder, API Key placeholder
// change, tool_call compatibility hint, refresh button presence. The dynamic
// model dropdown's three-state hints (loading/error/empty) depend on the
// pm:listModels IPC result against the live host machine — covered by manual
// testing in the feature plan to keep E2E deterministic across CI / dev.

test('Provider dropdown includes Ollama (local) option', async ({ shelfApp: { page } }) => {
  await openSettingsOnPmTab(page);

  const providerSelect = page.locator('.settings-body .settings-group')
    .filter({ hasText: 'Provider' })
    .locator('select');
  await expect(providerSelect.locator('option', { hasText: 'Ollama' })).toHaveCount(1);

  await page.keyboard.press('Escape');
});

test('Selecting Ollama reveals Base URL input with localhost placeholder', async ({ shelfApp: { page } }) => {
  await openSettingsOnPmTab(page);

  const body = page.locator('.settings-body');
  await body.locator('.settings-group').filter({ hasText: 'Provider' }).locator('select').selectOption('ollama');

  const baseUrlInput = body.locator('.settings-group').filter({ hasText: 'Base URL' }).locator('input');
  await expect(baseUrlInput).toBeVisible({ timeout: 2_000 });
  await expect(baseUrlInput).toHaveAttribute('placeholder', 'http://localhost:11434/v1');

  await page.keyboard.press('Escape');
});

test('Selecting Ollama changes API Key placeholder to "Optional"', async ({ shelfApp: { page } }) => {
  await openSettingsOnPmTab(page);

  const body = page.locator('.settings-body');
  await body.locator('.settings-group').filter({ hasText: 'Provider' }).locator('select').selectOption('ollama');

  const apiKeyInput = body.locator('.settings-group').filter({ hasText: 'API Key' }).locator('input');
  await expect(apiKeyInput).toHaveAttribute('placeholder', /Optional/i);

  await page.keyboard.press('Escape');
});

test('Selecting Ollama shows tool_call compatibility hint', async ({ shelfApp: { page } }) => {
  await openSettingsOnPmTab(page);

  const body = page.locator('.settings-body');
  await body.locator('.settings-group').filter({ hasText: 'Provider' }).locator('select').selectOption('ollama');

  // The hint references qwen3:8b as the verified working model — see
  // GOTCHAS "Ollama: model 看似支援 tool_call、實測只吐 JSON text".
  await expect(body.locator('.settings-sub-hint', { hasText: /qwen3:8b/ })).toBeVisible({ timeout: 2_000 });

  await page.keyboard.press('Escape');
});

test('Selecting Ollama shows refresh button next to Model select', async ({ shelfApp: { page } }) => {
  await openSettingsOnPmTab(page);

  const body = page.locator('.settings-body');
  await body.locator('.settings-group').filter({ hasText: 'Provider' }).locator('select').selectOption('ollama');

  // Refresh button is only rendered for providers with dynamicModelList=true.
  // OpenAI / Gemini won't show it; Ollama does.
  const refreshBtn = body.locator('.settings-icon-btn[title="Refresh model list"]');
  await expect(refreshBtn).toBeVisible({ timeout: 2_000 });

  await page.keyboard.press('Escape');
});

test('Switching OpenAI → Ollama → OpenAI hides refresh button on non-dynamic providers', async ({ shelfApp: { page } }) => {
  await openSettingsOnPmTab(page);

  const body = page.locator('.settings-body');
  const providerSelect = body.locator('.settings-group').filter({ hasText: 'Provider' }).locator('select');
  const refreshBtn = body.locator('.settings-icon-btn[title="Refresh model list"]');

  await providerSelect.selectOption('openai');
  await expect(refreshBtn).toHaveCount(0);

  await providerSelect.selectOption('ollama');
  await expect(refreshBtn).toBeVisible({ timeout: 2_000 });

  await providerSelect.selectOption('gemini');
  await expect(refreshBtn).toHaveCount(0);

  await page.keyboard.press('Escape');
});
