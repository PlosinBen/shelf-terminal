import { test, expect, readActiveTerminalText } from './helpers';
import { CLAUDE_PROVIDER } from '../src/shared/agent-providers';
import { IPC } from '../src/shared/ipc-channels';
import fs from 'fs';
import path from 'path';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// Helper: create a project and connect (opens a terminal tab)
async function setupProject(page: any) {
  const projectIndex = await page.locator('.sidebar-item').count();
  const projectName = ['shelf-test-a', 'shelf-test-b', 'shelf-test-c'][projectIndex];
  if (!projectName) throw new Error(`No test directory available for project ${projectIndex + 1}`);

  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  // Wait for listDir to populate the path — Cmd+Enter on an empty path
  // creates a project with name "project" and empty cwd. See
  // agent-flows.spec.ts setupProject for the full race explanation.
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.locator('.folder-picker-item', { hasText: projectName }).click();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
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
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
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

  await expect(panel.locator('.settings-tab.active')).toHaveText('General');
  const themeSelect = page.locator('.settings-select').first();
  await expect(themeSelect).toBeVisible();

  const path = panel.getByPlaceholder('~ (home directory)');
  await path.fill('/nonexistent-shelf-settings-test/directory');
  await panel.getByRole('button', { name: 'Model Catalog' }).click();
  await expect(panel.locator('.settings-section-title')).toHaveText('Model Catalog');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.locator('.settings-tab.active')).toHaveText('General');
  await expect(panel.locator('.settings-path-error')).toContainText(await path.inputValue());
  await panel.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(panel.locator('.settings-section-title')).toHaveText(['Display', 'History', 'Idle Sessions']);

  // Keybindings are on Shortcuts tab
  await page.locator('.settings-tab', { hasText: 'Shortcuts' }).click();
  const keybindingBtn = page.locator('.keybinding-btn').first();
  await expect(keybindingBtn).toBeVisible();

  await page.locator('.settings-close').click();
  await expect(panel).not.toBeVisible();
});

test('saved themes apply button, label and validation colors in Settings', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const panel = page.locator('.settings-panel');
  const save = panel.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toHaveCSS('color', 'rgb(30, 30, 46)');
  for (const [theme, ink, muted] of [
    ['nord', 'rgb(32, 37, 46)', 'rgb(164, 176, 194)'],
    ['fern', 'rgb(48, 35, 13)', 'rgb(184, 207, 168)'],
    ['saffron', 'rgb(255, 241, 209)', 'rgb(92, 68, 38)'],
    ['orchid', 'rgb(16, 54, 44)', 'rgb(216, 175, 208)'],
    ['catppuccin-latte', 'rgb(255, 255, 255)', 'rgb(83, 87, 108)'],
  ]) {
    await panel.locator('.settings-select').first().selectOption(theme);
    await save.click();
    await expect(panel).not.toBeVisible();
    await page.keyboard.press(`${modifier}+,`);
    await expect(save).toHaveCSS('color', ink);
    await expect(panel.getByText('Theme', { exact: true })).toHaveCSS('color', muted);
  }
  await panel.getByPlaceholder('~ (home directory)').fill('/nonexistent-shelf-test/dir');
  await save.click();
  await expect(panel.locator('.settings-path-error')).toHaveCSS('color', 'rgb(153, 33, 57)');
});

test('General saves the default local path in the existing settings file', async ({ shelfApp: { page, userDataDir } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const panel = page.locator('.settings-panel');
  const localPath = panel.getByPlaceholder('~ (home directory)');
  await localPath.fill(userDataDir);
  await panel.getByRole('button', { name: 'Terminal', exact: true }).click();
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  const settingsFile = path.join(userDataDir, 'settings.json');
  await expect.poll(() => fs.existsSync(settingsFile) && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).defaultLocalPath).toBe(userDataDir);
  await page.keyboard.press(`${modifier}+,`);
  await expect(localPath).toHaveValue(userDataDir);
});

test('settings cancel discards changes', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+,`);
  const panel = page.locator('.settings-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });

  await panel.getByRole('button', { name: 'Terminal', exact: true }).click();
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
  await panel.getByRole('button', { name: 'Terminal', exact: true }).click();
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
  await page.locator('.default-tab-add', { hasText: 'Add Terminal' }).click();
  await expect(page.locator('.default-tab-row')).toHaveCount(initialCount + 1);

  // Remove last tab
  const removeButtons = page.locator('.default-tab-remove');
  await removeButtons.last().click();
  await expect(page.locator('.default-tab-row')).toHaveCount(initialCount);

  await page.locator('.settings-close').click();
});

test('project edit adds Agent startup rows with separate same-provider bindings across reconnect', async ({ shelfApp: { page, userDataDir } }) => {
  await ensureConnected(page);

  const item = page.locator('.sidebar-item').first();
  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  const editPanel = page.locator('.project-edit-panel');
  await expect(editPanel).toBeVisible({ timeout: 3_000 });

  const addAgent = editPanel.locator('.default-tab-add', { hasText: 'Add Agent' });
  await addAgent.click();
  await addAgent.click();
  const agentRows = editPanel.locator('.default-tab-row', {
    has: page.locator('.default-tab-kind-agent'),
  });
  await expect(agentRows).toHaveCount(2);
  const names = ['Startup Implementer', 'Startup Reviewer'];
  for (const [index, name] of names.entries()) {
    await agentRows.nth(index).locator('.default-tab-provider').selectOption(CLAUDE_PROVIDER);
    await agentRows.nth(index).locator('.default-tab-name').fill(name);
  }
  await editPanel.locator('.project-edit-footer .conn-btn-next').click();
  await expect(editPanel).not.toBeVisible({ timeout: 3_000 });

  // Same-provider startup Views own separate stable sessions. Review the Project
  // and persistence contracts if this changes: visible tabs alone cannot prove
  // their bindings survive Save and reconnect without sharing or replacing a session.
  const saved = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  const savedAgents = saved.defaultTabs.filter(tab => tab.kind === 'agent');
  expect(savedAgents.map(tab => tab.name)).toEqual(names);
  for (const tab of savedAgents) {
    expect(tab.provider).toBe(CLAUDE_PROVIDER);
    expect(tab.sessionId).toEqual(expect.stringMatching(/\S/));
    expect(saved.agentViews[tab.sessionId!].provider).toBe(CLAUDE_PROVIDER);
  }
  expect(savedAgents[0].sessionId).not.toBe(savedAgents[1].sessionId);
  await expect.poll(() => {
    const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8'));
    const project = document.projects.find((project: { id: string }) => project.id === saved.id);
    return { defaultTabs: project?.defaultTabs, agentViews: project?.agentViews };
  }).toEqual({ defaultTabs: saved.defaultTabs, agentViews: saved.agentViews });

  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Disconnect' }).click();
  await expect(page.locator('.connect-prompt')).toBeVisible({ timeout: 5_000 });
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(3, { timeout: 8_000 });
  for (const name of names) {
    await expect(page.locator('.tab-bar .tab', { hasText: name })).toBeVisible();
  }
  const reconnected = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  expect(reconnected.defaultTabs).toEqual(saved.defaultTabs);
  for (const tab of savedAgents) {
    expect(reconnected.agentViews[tab.sessionId!].provider).toBe(CLAUDE_PROVIDER);
  }
});

test('project edit: a web default tab is added, persists, and opens as a web tab on connect', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const item = page.locator('.sidebar-item').first();
  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();

  const editPanel = page.locator('.project-edit-panel');
  await expect(editPanel).toBeVisible({ timeout: 3_000 });
  await expect(page.locator('.default-tab-row').first()).toBeVisible({ timeout: 3_000 });

  // Add a Web default tab via the dedicated button → a row tagged "web".
  await page.locator('.default-tab-add', { hasText: 'Add Web' }).click();
  const webRow = page.locator('.default-tab-row', { has: page.locator('.default-tab-kind-web') });
  await expect(webRow).toHaveCount(1);
  // Its second field is a URL input (not a command) — set a starting URL.
  await webRow.locator('.default-tab-cmd').fill('https://example.com');
  await page.locator('.project-edit-footer .conn-btn-next').click();
  await expect(editPanel).not.toBeVisible({ timeout: 3_000 });

  // Reopen → the web row + its URL round-tripped through persistence.
  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  await expect(editPanel).toBeVisible({ timeout: 3_000 });
  const reopenedWebRow = page.locator('.default-tab-row', { has: page.locator('.default-tab-kind-web') });
  await expect(reopenedWebRow).toHaveCount(1);
  await expect(reopenedWebRow.locator('.default-tab-cmd')).toHaveValue('https://example.com');
  await page.locator('.settings-close').click();

  // Disconnect + reconnect → the web default tab opens alongside the terminal.
  await item.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Disconnect' }).click();
  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  // Two tabs now open on connect (terminal + the web default); the web one is
  // labelled "Web". Activating it shows the web tab's toolbar/address bar.
  const webTab = page.locator('.tab-bar .tab', { hasText: 'Web' });
  await expect(webTab).toBeVisible({ timeout: 5_000 });
  await webTab.click();
  await expect(page.locator('.web-tab-toolbar:visible')).toBeVisible({ timeout: 5_000 });
});

test('Save to Default preserves Terminal, Web, and Agent runtime kinds', async ({ shelfApp: { page, userDataDir } }) => {
  await ensureConnected(page);
  const projectItem = page.locator('.sidebar-item').first();

  await projectItem.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  const panel = page.locator('.project-edit-panel');
  const terminalRow = panel.locator('.default-tab-row').first();
  await terminalRow.locator('.default-tab-name').fill('Base Terminal');
  await terminalRow.locator('.default-tab-cmd').fill('printf saved-terminal');
  await panel.locator('.default-tab-add', { hasText: 'Add Web' }).click();
  const webRow = panel.locator('.default-tab-row', { has: page.locator('.default-tab-kind-web') });
  await webRow.locator('.default-tab-name').fill('Portal');
  await webRow.locator('.default-tab-cmd').fill('https://example.com');
  await panel.locator('.project-edit-footer .conn-btn-next').click();
  await expect(panel).not.toBeVisible({ timeout: 3_000 });

  await projectItem.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Disconnect' }).click();
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });

  const saveRuntimeTab = async (label: string) => {
    await page.locator('.tab-bar .tab', { hasText: label }).click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Save to Default' }).click();
  };
  await saveRuntimeTab('Base Terminal');
  await saveRuntimeTab('Portal');

  await page.locator('.tab-add').click();
  await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
  await expect(page.locator('.tab-bar .tab', { hasText: 'Claude' })).toBeVisible({ timeout: 5_000 });
  await saveRuntimeTab('Claude');

  const readDefaultTabs = () => {
    const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8'));
    return document.projects[0]?.defaultTabs;
  };
  await expect.poll(readDefaultTabs).toEqual([
    { name: 'Base Terminal', cmd: 'printf saved-terminal' },
    { name: 'Portal', kind: 'web', url: 'https://example.com' },
    { name: 'Base Terminal', cmd: 'printf saved-terminal' },
    { name: 'Portal', kind: 'web', url: 'https://example.com' },
    { name: 'Claude', kind: 'agent', provider: CLAUDE_PROVIDER, sessionId: expect.any(String) },
  ]);

  await page.locator('.tab-bar .tab', { hasText: 'Claude' }).click({ button: 'right' });
  const duplicateAction = page.locator('.context-menu-item', { hasText: 'Already saved as Claude' });
  await expect(duplicateAction).toBeDisabled();
  await expect(duplicateAction).toHaveAttribute('title', 'Claude already starts this Agent View');
});

test('Quick Commands list only Terminal targets and visibly refuse the current Agent tab', async ({ shelfApp: { app, page } }) => {
  await ensureConnected(page);
  const projectItem = page.locator('.sidebar-item').first();
  await projectItem.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  const panel = page.locator('.project-edit-panel');

  await panel.locator('.default-tab-add', { hasText: 'Add Agent' }).click();
  await panel.locator('.default-tab-add', { hasText: 'Add Web' }).click();
  await panel.locator('.default-tab-add', { hasText: 'Add Command' }).click();
  const commandRow = panel.locator('.quick-command-row');
  await commandRow.locator('.quick-command-label').fill('Run checks');
  await commandRow.locator('.quick-command-cmd').fill('echo must-not-reach-pty');
  await expect(commandRow.locator('.quick-command-target option')).toHaveText([
    'Current tab',
    'Terminal',
  ]);
  await panel.locator('.project-edit-footer .conn-btn-next').click();
  await expect(panel).not.toBeVisible({ timeout: 3_000 });

  await page.locator('.tab-add').click();
  await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
  await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

  await app.evaluate(({ ipcMain }, channel) => {
    (globalThis as any).__quickCommandPtyInputs = 0;
    ipcMain.prependListener(channel, () => {
      (globalThis as any).__quickCommandPtyInputs++;
    });
  }, IPC.PTY_INPUT);

  await page.keyboard.press(`${modifier}+p`);
  const picker = page.locator('.command-picker');
  await expect(picker).toBeVisible({ timeout: 3_000 });
  await picker.locator('.command-picker-item', { hasText: 'Run checks' }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.locator('.project-notice-banner')).toHaveText(
    /Current tab "Claude" is an Agent tab, not a Terminal\./,
  );
  const ptyInputs = await app.evaluate(() => (globalThis as any).__quickCommandPtyInputs);
  expect(ptyInputs).toBe(0);
});

// ── Sidebar ──

test('sidebar collapse and expand', async ({ shelfApp: { page } }) => {
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toBeVisible();

  // Collapse via mod+Shift+B (project list toggle)
  await page.keyboard.press(`${modifier}+Shift+b`);
  await expect(sidebar).not.toBeVisible();

  // Expand via the footer Projects toggle (always visible)
  const projectsToggle = page.locator('.right-tab-btn', { hasText: 'Projects' });
  await expect(projectsToggle).toBeVisible();
  await projectsToggle.click();
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

test('mod+Shift+D toggles dev tools panel', async ({ shelfApp: { page } }) => {
  const panel = page.locator('.devtools-panel');
  const collapsed = page.locator('.right-tab-btn', { hasText: 'Dev Tools' });

  // Initially footer toggle visible (inactive), panel hidden
  await expect(collapsed).toBeVisible({ timeout: 3_000 });
  await expect(collapsed).not.toHaveClass(/active/);
  await expect(panel).not.toBeVisible();

  // Open via keyboard — toggle stays visible but becomes active
  await page.keyboard.press(`${modifier}+Shift+d`);
  await expect(panel).toBeVisible({ timeout: 3_000 });
  await expect(collapsed).toBeVisible();
  await expect(collapsed).toHaveClass(/active/);

  // Close via keyboard — active class removed
  await page.keyboard.press(`${modifier}+Shift+d`);
  await expect(panel).not.toBeVisible();
  await expect(collapsed).toBeVisible();
  await expect(collapsed).not.toHaveClass(/active/);
});

test('dev tools panel opens via footer toggle click', async ({ shelfApp: { page } }) => {
  const panel = page.locator('.devtools-panel');
  const collapsed = page.locator('.right-tab-btn', { hasText: 'Dev Tools' });

  await expect(collapsed).toBeVisible({ timeout: 3_000 });
  await collapsed.click();
  await expect(panel).toBeVisible({ timeout: 3_000 });

  // Close via × button
  await panel.locator('.settings-close').click();
  await expect(panel).not.toBeVisible();
});

test('dev tools accordion expands and collapses', async ({ shelfApp: { page } }) => {
  await page.keyboard.press(`${modifier}+Shift+d`);
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

test('mod+P toggles command picker', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const picker = page.locator('.command-picker-overlay');
  await expect(picker).not.toBeVisible();

  await page.keyboard.press(`${modifier}+p`);
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

test('mod+shift+backslash toggles split view', async ({ shelfApp: { page } }) => {
  await ensureConnected(page);

  const tabs = page.locator('.tab-bar .tab');
  const before = await tabs.count();

  // Open split — adds a new tab
  await page.keyboard.press(`${modifier}+Shift+\\`);
  await expect(tabs).toHaveCount(before + 1, { timeout: 5_000 });

  // Close split — removes the split tab
  await page.keyboard.press(`${modifier}+Shift+\\`);
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
  // mod+W opens a confirmation dialog (see RemoveConfirmDialog); confirm it.
  await page.locator('.conn-btn-danger', { hasText: 'Remove' }).click();
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
  await page.locator('.context-menu-item', { hasText: 'Remove' }).click();
  // "Remove" opens the confirmation dialog; click through to actually delete.
  await page.locator('.conn-btn-danger', { hasText: 'Remove' }).click();

  await expect(items).toHaveCount(before - 1, { timeout: 5_000 });
});

// ── BottomBar grouping ──

// The right cluster is split into three divider-separated groups —
// version | left sidebar (Projects) | right sidebar (PM/Notes/Skills/MCP/Backup/DevTools).
// No project needed: the bottom bar is always mounted.
test('bottom bar groups the right cluster with dividers', async ({ shelfApp: { page } }) => {
  const groups = page.locator('.bottom-bar-right > .bottom-bar-group');
  const seps = page.locator('.bottom-bar-right > .bottom-bar-vsep');
  await expect(groups).toHaveCount(3);
  await expect(seps).toHaveCount(2);

  // Group 2 = the left-sidebar toggle (Projects) on its own.
  const leftGroup = groups.nth(1);
  await expect(leftGroup.locator('.right-tab-btn')).toHaveCount(1);
  await expect(leftGroup.locator('.sr-only', { hasText: 'Projects' })).toHaveCount(1);

  // Group 3 = the six right-sidebar features, MCP sitting after Skills.
  const rightGroup = groups.nth(2);
  await expect(rightGroup.locator('.right-tab-btn .sr-only'))
    .toHaveText(['PM', 'Notes', 'Skills', 'MCP', 'Backup', 'Dev Tools']);
});

// The grouped MCP icon opens the MCP right-sidebar view (it lives in group 3).
test('bottom bar MCP icon toggles the MCP view', async ({ shelfApp: { page } }) => {
  const mcpBtn = page.locator('.bottom-bar-right .right-tab-btn', { hasText: 'MCP' });
  const view = page.locator('.mcp-view');

  await expect(mcpBtn).toBeVisible({ timeout: 3_000 });
  await expect(mcpBtn).not.toHaveClass(/active/);
  await expect(view).not.toBeVisible();

  await mcpBtn.click();
  await expect(view).toBeVisible({ timeout: 3_000 });
  await expect(mcpBtn).toHaveClass(/active/);

  // Close via the panel's × — toggle goes inactive.
  await view.locator('.notes-close').click();
  await expect(view).not.toBeVisible();
  await expect(mcpBtn).not.toHaveClass(/active/);
});
