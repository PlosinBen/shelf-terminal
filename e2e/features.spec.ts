import { test, expect } from './helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// Read the xterm buffer text for the active tab of the active project via the
// __shelfTerminalCache__ test hook. The WebGL renderer paints to canvas so
// `.xterm-rows` has no text — DOM-based assertions against it always fail.
async function readActiveTerminalText(page: any): Promise<string> {
  return await page.evaluate(() => {
    const cache = (window as any).__shelfTerminalCache__ as Map<string, any> | undefined;
    const visibleContainer = Array.from(document.querySelectorAll('.terminal-container'))
      .find((c) => (c as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
    if (!cache || !visibleContainer) return '';
    // Match the active entry by element parent/ancestor chain — each cache
    // entry's term.element lives under its own .terminal-container.
    for (const [, cached] of cache) {
      if (cached.term?.element && visibleContainer.contains(cached.term.element)) {
        const buf = cached.term.buffer.active;
        let out = '';
        for (let y = 0; y < buf.length; y++) {
          const line = buf.getLine(y);
          if (line) out += line.translateToString(true) + '\n';
        }
        return out;
      }
    }
    return '';
  });
}

// Helper: create a project and connect (opens a terminal tab)
async function setupProject(page: any) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(1000);
}

// Helper: ensure active project is connected with at least 1 tab
async function ensureConnected(page: any) {
  if (await page.locator('.sidebar-item').count() === 0) {
    await setupProject(page);
    return;
  }
  const tabs = page.locator('.tab-bar .tab');
  if (await tabs.count() > 0) return;

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(1000);
}

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
  await ensureConnected(page);

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
  await ensureConnected(page);

  const item = page.locator('.sidebar-item').first();
  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();

  const editPanel = page.locator('.project-edit-panel');
  await expect(editPanel).toBeVisible({ timeout: 3_000 });

  // Wait for default tabs to populate (React effect race)
  await expect(page.locator('.default-tab-row').first()).toBeVisible({ timeout: 3_000 });
  const initialCount = await page.locator('.default-tab-row').count();

  // Add tab
  await page.locator('.default-tab-add', { hasText: 'Add Tab' }).click();
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
  await ensureConnected(page);

  const tab = page.locator('.tab-bar .tab').first();
  await tab.dblclick();

  const input = page.locator('.tab-rename-input');
  await expect(input).toBeVisible({ timeout: 3_000 });

  await input.fill('My Custom Tab');
  await input.press('Enter');

  await expect(page.locator('.tab-label').first()).toContainText('My Custom Tab');
});

test('close tab removes it', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  // Ensure at least 2 tabs
  const tabs = page.locator('.tab-bar .tab');
  if (await tabs.count() < 2) {
    await page.keyboard.press(`${modifier}+t`);
    await expect(tabs).toHaveCount(2, { timeout: 5_000 });
  }

  const countBefore = await tabs.count();
  await tabs.last().locator('.tab-close').click();
  await expect(tabs).toHaveCount(countBefore - 1, { timeout: 5_000 });
});

// ── Project Disconnect / Reconnect ──

test('disconnect removes tabs, reconnect restores', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const tabs = page.locator('.tab-bar .tab');
  await expect(tabs.first()).toBeVisible({ timeout: 3_000 });

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
  // Ensure at least 2 projects
  while (await page.locator('.sidebar-item').count() < 2) {
    await setupProject(page);
  }

  const items = page.locator('.sidebar-item');
  await expect(items).toHaveCount(2, { timeout: 5_000 });

  // Ensure both projects are connected
  await items.nth(0).click();
  await ensureConnected(page);
  await items.nth(1).click();
  await ensureConnected(page);

  let visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 5_000 });

  await items.nth(0).click();
  visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 5_000 });

  await items.nth(1).click();
  visibleTerminal = page.locator('.terminal-container:visible');
  await expect(visibleTerminal).toBeVisible({ timeout: 5_000 });

  const text = await readActiveTerminalText(page);
  expect(text.length).toBeGreaterThan(0);
});

test('switching tabs within a project shows correct terminal', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const tabs = page.locator('.tab-bar .tab');
  if (await tabs.count() < 2) {
    await page.keyboard.press(`${modifier}+t`);
    await expect(tabs).toHaveCount(2, { timeout: 5_000 });
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
  await ensureConnected(page);
  await page.waitForTimeout(500);

  // Type a command to produce identifiable output
  let terminal = page.locator('.terminal-container:visible');
  await terminal.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo SHELF_TEST_P1\n');
  await page.waitForTimeout(1000);

  // Verify output exists (xterm buffer, not DOM — WebGL renderer paints to canvas)
  expect(await readActiveTerminalText(page)).toContain('SHELF_TEST_P1');

  // Select project 2, connect
  await items.nth(1).click();
  await ensureConnected(page);
  await page.waitForTimeout(500);

  // Switch back to project 1
  await items.nth(0).click();
  await page.waitForTimeout(500);

  // Verify terminal is visible and content is preserved
  terminal = page.locator('.terminal-container:visible');
  await expect(terminal).toBeVisible({ timeout: 5_000 });
  expect(await readActiveTerminalText(page)).toContain('SHELF_TEST_P1');
});

// ── Project Reorder ──

test('terminal content preserved after project reorder', async ({ shelfApp: { page } }) => {
  // Ensure 2 connected projects
  const items = page.locator('.sidebar-item');
  while (await items.count() < 2) {
    await setupProject(page);
  }

  // Connect project 1 and produce identifiable output
  await items.nth(0).click();
  await ensureConnected(page);
  await page.waitForTimeout(500);
  let terminal = page.locator('.terminal-container:visible');
  await terminal.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo REORDER_P1\n');
  await page.waitForTimeout(1000);

  // Connect project 2 and produce identifiable output
  await items.nth(1).click();
  await ensureConnected(page);
  await page.waitForTimeout(500);
  terminal = page.locator('.terminal-container:visible');
  await terminal.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo REORDER_P2\n');
  await page.waitForTimeout(1000);

  // Reorder: dispatch drag events to swap project 0 and 1
  const srcItem = items.nth(0);
  const dstItem = items.nth(1);
  const srcBox = await srcItem.boundingBox();
  const dstBox = await dstItem.boundingBox();
  if (!srcBox || !dstBox) throw new Error('Cannot get bounding boxes for sidebar items');

  await page.evaluate(({ srcSel, dstSel }) => {
    const src = document.querySelectorAll('.sidebar-item')[srcSel];
    const dst = document.querySelectorAll('.sidebar-item')[dstSel];

    const dt = new DataTransfer();
    dt.setData('text/plain', '0');

    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  }, { srcSel: 0, dstSel: 1 });
  await page.waitForTimeout(500);

  // Check active project terminal is still visible and has content
  terminal = page.locator('.terminal-container:visible');
  await expect(terminal).toBeVisible({ timeout: 5_000 });
  expect((await readActiveTerminalText(page)).length).toBeGreaterThan(0);

  // Switch to the other project and verify its terminal too
  await items.nth(0).click();
  await page.waitForTimeout(500);
  terminal = page.locator('.terminal-container:visible');
  await expect(terminal).toBeVisible({ timeout: 5_000 });
  expect((await readActiveTerminalText(page)).length).toBeGreaterThan(0);
});

// ── Dev Tools ──

test('mod+D toggles dev tools panel', async ({ shelfApp: { page } }) => {
  const panel = page.locator('.devtools-panel');
  const collapsed = page.locator('.devtools-tab-collapsed');

  // Initially collapsed tab visible, panel hidden
  await expect(collapsed).toBeVisible({ timeout: 3_000 });
  await expect(panel).not.toBeVisible();

  // Open via keyboard
  await page.keyboard.press(`${modifier}+d`);
  await expect(panel).toBeVisible({ timeout: 3_000 });
  await expect(collapsed).not.toBeVisible();

  // Close via keyboard
  await page.keyboard.press(`${modifier}+d`);
  await expect(panel).not.toBeVisible();
  await expect(collapsed).toBeVisible();
});

test('dev tools panel opens via collapsed tab click', async ({ shelfApp: { page } }) => {
  const panel = page.locator('.devtools-panel');
  const collapsed = page.locator('.devtools-tab-collapsed');

  await expect(collapsed).toBeVisible({ timeout: 3_000 });
  await collapsed.click();
  await expect(panel).toBeVisible({ timeout: 3_000 });

  // Close via × button
  await panel.locator('.settings-close').click();
  await expect(panel).not.toBeVisible();
});

test('dev tools accordion expands and collapses', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+d`);
  const panel = page.locator('.devtools-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });

  // Base64 should be expanded by default
  const base64Header = panel.locator('.devtools-section-header', { hasText: 'Base64' });
  const base64Body = base64Header.locator('..').locator('.devtools-section-body');
  await expect(base64Body).toBeVisible();

  // Collapse Base64
  await base64Header.click();
  await expect(base64Body).not.toBeVisible();

  // Expand JSON
  const jsonHeader = panel.locator('.devtools-section-header', { hasText: 'JSON' });
  await jsonHeader.click();
  const jsonBody = jsonHeader.locator('..').locator('.devtools-section-body');
  await expect(jsonBody).toBeVisible();

  // Close panel
  await page.keyboard.press(`${modifier}+d`);
});

// ── Command Picker ──

test('mod+E toggles command picker', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const picker = page.locator('.command-picker-overlay');
  await expect(picker).not.toBeVisible();

  await page.keyboard.press(`${modifier}+e`);
  await expect(picker).toBeVisible({ timeout: 3_000 });

  await page.keyboard.press('Escape');
  await expect(picker).not.toBeVisible();
});

// ── New Project via Keyboard ──

test('mod+O opens folder picker', async ({ shelfApp: { page } }) => {
  const overlay = page.locator('.folder-picker-overlay');
  await expect(overlay).not.toBeVisible();

  await page.keyboard.press(`${modifier}+o`);
  await expect(overlay).toBeVisible({ timeout: 3_000 });

  // Close via cancel button
  await page.locator('.conn-btn-cancel').click();
  await expect(overlay).not.toBeVisible({ timeout: 3_000 });
});

// ── Split View ──

test('mod+backslash toggles split view', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const tabs = page.locator('.tab-bar .tab');
  const before = await tabs.count();

  // Open split — adds a new tab
  await page.keyboard.press(`${modifier}+\\`);
  await expect(tabs).toHaveCount(before + 1, { timeout: 5_000 });

  // Close split — removes the split tab
  await page.keyboard.press(`${modifier}+\\`);
  await expect(tabs).toHaveCount(before, { timeout: 5_000 });
});

// ── Tab Switch via Keyboard ──

test('mod+Shift+brackets switches tabs', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const tabs = page.locator('.tab-bar .tab');
  if (await tabs.count() < 2) {
    await page.keyboard.press(`${modifier}+t`);
    await expect(tabs).toHaveCount(2, { timeout: 5_000 });
    await page.waitForTimeout(500);
  }

  // Activate first tab
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveClass(/active/, { timeout: 3_000 });

  // mod+Shift+] → next tab
  await page.keyboard.press(`${modifier}+Shift+]`);
  await expect(tabs.nth(1)).toHaveClass(/active/, { timeout: 3_000 });

  // mod+Shift+[ → prev tab
  await page.keyboard.press(`${modifier}+Shift+[`);
  await expect(tabs.nth(0)).toHaveClass(/active/, { timeout: 3_000 });
});

// ── Close Project ──

test('mod+W closes active project', async ({ shelfApp: { page } }) => {
  // Ensure at least 2 projects so closing one still leaves another
  while (await page.locator('.sidebar-item').count() < 2) {
    await setupProject(page);
  }

  const items = page.locator('.sidebar-item');
  const before = await items.count();

  await page.keyboard.press(`${modifier}+w`);
  await expect(items).toHaveCount(before - 1, { timeout: 5_000 });
});

test('close project via context menu removes it', async ({ shelfApp: { page } }) => {
  // Ensure at least 1 project
  if (await page.locator('.sidebar-item').count() === 0) {
    await setupProject(page);
  }

  const items = page.locator('.sidebar-item');
  const before = await items.count();

  await items.last().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Close' }).click();

  await expect(items).toHaveCount(before - 1, { timeout: 5_000 });
});
