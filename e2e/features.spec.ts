import { test, expect } from './helpers';

// Helper: create a project and open a tab
async function setupProject(page: any) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(1000);
}

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// ── Search ──

test('search bar opens with mod+F and closes with Escape', async ({ shelfApp: { page } }) => {
  await setupProject(page);

  await page.keyboard.press(`${modifier}+f`);
  const searchBar = page.locator('.search-bar');
  await expect(searchBar).toBeVisible({ timeout: 3_000 });

  await page.keyboard.press('Escape');
  await expect(searchBar).not.toBeVisible();
});

// ── Settings ──

test('settings panel opens with mod+comma', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const panel = page.locator('.settings-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });

  const themeSelect = page.locator('.settings-select').first();
  await expect(themeSelect).toBeVisible();

  const keybindingBtn = page.locator('.keybinding-btn').first();
  await expect(keybindingBtn).toBeVisible();

  await page.locator('.settings-close').click();
  await expect(panel).not.toBeVisible();
});

test('settings cancel discards changes', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const panel = page.locator('.settings-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });

  // Change font size
  const fontInput = panel.locator('.settings-input[type="number"]').first();
  const originalValue = await fontInput.inputValue();
  await fontInput.fill('20');

  // Cancel
  await panel.locator('.conn-btn-cancel', { hasText: 'Cancel' }).click();
  await expect(panel).not.toBeVisible();

  // Reopen and check value is unchanged
  await page.keyboard.press(`${modifier}+,`);
  await expect(panel).toBeVisible({ timeout: 3_000 });
  const currentValue = await panel.locator('.settings-input[type="number"]').first().inputValue();
  expect(currentValue).toBe(originalValue);

  await page.locator('.settings-close').click();
});

// ── Project Edit ──

test('project edit panel opens from context menu', async ({ shelfApp: { page } }) => {
  if (await page.locator('.sidebar-item').count() === 0) {
    await setupProject(page);
  }

  const item = page.locator('.sidebar-item').first();
  await item.click({ button: 'right' });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible({ timeout: 3_000 });

  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();

  const editPanel = page.locator('.project-edit-panel');
  await expect(editPanel).toBeVisible({ timeout: 3_000 });

  const textarea = page.locator('.project-edit-textarea');
  await expect(textarea).toBeVisible();

  // Has default tabs section (auto-wait for React effect to populate)
  await expect(page.locator('.default-tab-row').first()).toBeVisible({ timeout: 3_000 });

  await page.locator('.settings-close').click();
  await expect(editPanel).not.toBeVisible();
});

test('project edit default tabs can add and remove', async ({ shelfApp: { page } }) => {
  const item = page.locator('.sidebar-item').first();
  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();

  const editPanel = page.locator('.project-edit-panel');
  await expect(editPanel).toBeVisible({ timeout: 3_000 });

  // Wait for default tabs to populate (React effect race)
  await expect(page.locator('.default-tab-row').first()).toBeVisible({ timeout: 3_000 });
  const initialCount = await page.locator('.default-tab-row').count();

  // Add tab
  await page.locator('.default-tab-add').click();
  await expect(page.locator('.default-tab-row')).toHaveCount(initialCount + 1);

  // Remove last tab
  const removeButtons = page.locator('.default-tab-remove');
  await removeButtons.last().click();
  await expect(page.locator('.default-tab-row')).toHaveCount(initialCount);

  await page.locator('.settings-close').click();
});

// ── Sidebar ──

test('sidebar collapse and expand', async ({ shelfApp: { page } }) => {
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toBeVisible();

  // Collapse via mod+B
  await page.keyboard.press(`${modifier}+b`);
  await expect(sidebar).not.toBeVisible();

  // Expand button should appear in tab bar
  const expandBtn = page.locator('.tab-sidebar-btn');
  await expect(expandBtn).toBeVisible();

  // Click to expand
  await expandBtn.click();
  await expect(sidebar).toBeVisible();
});

// ── Tab Management ──

test('tab rename via double click', async ({ shelfApp: { page } }) => {
  const tab = page.locator('.tab-bar .tab').first();
  await tab.dblclick();

  const input = page.locator('.tab-rename-input');
  await expect(input).toBeVisible({ timeout: 3_000 });

  await input.fill('My Custom Tab');
  await input.press('Enter');

  await expect(page.locator('.tab-label').first()).toContainText('My Custom Tab');
});

test('close tab removes it', async ({ shelfApp: { page } }) => {
  // Ensure at least 2 tabs
  const tabs = page.locator('.tab-bar .tab');
  const before = await tabs.count();
  if (before < 2) {
    await page.keyboard.press(`${modifier}+t`);
    await expect(tabs).toHaveCount(before + 1, { timeout: 5_000 });
  }

  const countBefore = await tabs.count();
  await tabs.last().locator('.tab-close').click();
  await expect(tabs).toHaveCount(countBefore - 1, { timeout: 5_000 });
});

// ── Project Disconnect / Reconnect ──

test('disconnect removes tabs, reconnect restores', async ({ shelfApp: { page } }) => {
  // Ensure project is connected
  const tabs = page.locator('.tab-bar .tab');
  if (await tabs.count() === 0) {
    const prompt = page.locator('.connect-prompt');
    if (await prompt.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await prompt.click();
      await page.waitForTimeout(1000);
    }
  }
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });

  // Disconnect via context menu
  const item = page.locator('.sidebar-item').first();
  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Disconnect' }).click();

  // Tabs should be gone, connect prompt appears
  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });

  // Reconnect
  await prompt.click();
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
});

// ── Project Switch ──

test('switching between projects preserves terminal', async ({ shelfApp: { page } }) => {
  const projectCount = await page.locator('.sidebar-item').count();
  if (projectCount < 2) {
    await setupProject(page);
  }

  const items = page.locator('.sidebar-item');
  await expect(items).toHaveCount(2, { timeout: 5_000 });

  await items.nth(1).click();
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await prompt.click();
    await page.waitForTimeout(1000);
  }

  let visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 5_000 });

  await items.nth(0).click();
  visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 5_000 });

  await items.nth(1).click();
  visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 5_000 });

  const xtermRows = visibleTerminal.locator('.xterm-rows');
  const text = await xtermRows.textContent();
  expect(text?.length).toBeGreaterThan(0);
});

test('switching tabs within a project shows correct terminal', async ({ shelfApp: { page } }) => {
  const tabs = page.locator('.tab-bar .tab');
  const tabCount = await tabs.count();
  if (tabCount < 2) {
    await page.keyboard.press(`${modifier}+t`);
    await expect(tabs).toHaveCount(tabCount + 1, { timeout: 5_000 });
    await page.waitForTimeout(1000);
  }

  await tabs.nth(0).click();
  let visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 3_000 });

  await tabs.nth(1).click();
  visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 3_000 });

  await tabs.nth(0).click();
  visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 3_000 });
});

// ── Project Switch via Keyboard ──

test('mod+ArrowDown/ArrowUp switches active project', async ({ shelfApp: { page } }) => {
  // Ensure 2 projects exist
  const items = page.locator('.sidebar-item');
  while (await items.count() < 2) {
    await setupProject(page);
  }

  // Activate first project
  await items.nth(0).click();
  await expect(items.nth(0)).toHaveClass(/active/, { timeout: 3_000 });

  // mod+ArrowDown → second project
  await page.keyboard.press(`${modifier}+ArrowDown`);
  await expect(items.nth(1)).toHaveClass(/active/, { timeout: 3_000 });

  // mod+ArrowUp → back to first project
  await page.keyboard.press(`${modifier}+ArrowUp`);
  await expect(items.nth(0)).toHaveClass(/active/, { timeout: 3_000 });
});

// ── Project Switch with Terminal Content ──

test('terminal content preserved after project switch', async ({ shelfApp: { page } }) => {
  // Ensure 2 projects exist
  const items = page.locator('.sidebar-item');
  while (await items.count() < 2) {
    await setupProject(page);
  }

  // Select project 1, connect, run a command
  await items.nth(0).click();
  let prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(1000);

  // Type a command to produce identifiable output
  let terminal = page.locator('.terminal-container:visible');
  await terminal.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo SHELF_TEST_P1\n');
  await page.waitForTimeout(1000);

  // Verify output exists
  let xtermRows = terminal.locator('.xterm-rows');
  let text = await xtermRows.textContent();
  expect(text).toContain('SHELF_TEST_P1');

  // Select project 2, connect
  await items.nth(1).click();
  prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await prompt.click();
  }
  await page.waitForTimeout(1000);

  // Switch back to project 1
  await items.nth(0).click();
  await page.waitForTimeout(500);

  // Verify terminal is visible and content is preserved
  terminal = page.locator('.terminal-container:visible');
  await expect(terminal).toBeVisible({ timeout: 5_000 });
  xtermRows = terminal.locator('.xterm-rows');
  text = await xtermRows.textContent();
  expect(text).toContain('SHELF_TEST_P1');
});

// ── Close Project ──

test('close project via context menu removes it', async ({ shelfApp: { page } }) => {
  const items = page.locator('.sidebar-item');
  const before = await items.count();

  await items.last().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Close' }).click();

  await expect(items).toHaveCount(before - 1, { timeout: 5_000 });
});
