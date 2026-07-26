import { test, expect } from './helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';

// App-level Skills panel (no project needed). Covers the L1 UI wire:
// open → New (template) → edit frontmatter name → Save (renames the folder) →
// Back → the list reflects the new name + description. Collision / validation
// logic is covered by src/main/skills-store.test.ts.

test('skills: create, rename via save, list reflects the new name', async ({ shelfApp }) => {
  const { page } = shelfApp;

  // Open the Skills panel from the BottomBar.
  await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
  await expect(page.locator('.skills-view')).toBeVisible();
  await expect(page.locator('.skills-view .notes-empty')).toContainText('No skills yet');

  // New → editor opens seeded with the template.
  await page.locator('.skills-view .notes-new-btn').click();
  const ta = page.locator('.skills-view .notes-textarea');
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue(/name: my-skill/);

  // Edit the frontmatter name + description, then Save (folder renames).
  await ta.fill('---\nname: kibana-connect\ndescription: reach kibana\n---\n\nssh to bastion');
  await page.locator('.skills-view .notes-send-btn').click();
  await expect(page.locator('.skills-view .skills-error')).toHaveCount(0);

  // Back to the list — it shows the renamed skill + description.
  await page.locator('.skills-view .notes-back').click();
  await expect(page.locator('.skills-list-name')).toHaveText('kibana-connect');
  await expect(page.locator('.skills-list-desc')).toContainText('reach kibana');
});

// Optional (disable-able) skills: the enable/disable toggle is a MOUNT decision,
// so it must be asserted against the PROJECTED TREE, not the panel list — a
// disabled skill STILL shows in the panel (you need it visible to re-enable),
// but its folder is dropped from ~/.shelf/apps/<appId>/skills/skills/<name>.
// Store/projection/hash logic is unit-covered; this proves the UI→pipeline wire.
test('skills: disable removes the skill from the projected tree; enable restores it', async ({ shelfApp }) => {
  const { page, userDataDir } = shelfApp;

  // Create a skill named `kibana-connect` (see the create/rename test above).
  await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
  await page.locator('.skills-view .notes-new-btn').click();
  await page.locator('.skills-view .notes-textarea')
    .fill('---\nname: kibana-connect\ndescription: reach kibana\n---\n\nssh to bastion');
  await page.locator('.skills-view .notes-send-btn').click();
  await expect(page.locator('.skills-view .skills-error')).toHaveCount(0);
  await page.locator('.skills-view .notes-back').click();
  await expect(page.locator('.skills-list-name')).toHaveText('kibana-connect');

  // The projected consumption path for THIS app instance (creating the skill ran
  // the pipeline, which stamps app-instance-id + projects locally).
  const appId = fs.readFileSync(path.join(userDataDir, 'app-instance-id'), 'utf-8').trim();
  const projected = path.join(os.homedir(), '.shelf', 'apps', appId, 'skills', 'skills', 'kibana-connect');
  // The `.disabled` marker in the SOURCE tree is what survives an app restart
  // (ensureScaffold never re-seeds skill folders) — assert it as the persistence substrate.
  const sourceMarker = path.join(userDataDir, 'skills', 'skills', 'kibana-connect', '.disabled');

  // Enabled by default → projected, no source marker.
  await expect.poll(() => fs.existsSync(projected)).toBe(true);
  expect(fs.existsSync(sourceMarker)).toBe(false);

  // Disable via the list-row power toggle → folder drops from the projected tree,
  // marker persists in source, and the row/toggle reflect the disabled state.
  await page.locator('.skills-enable-toggle').click();
  await expect(page.locator('.skills-list-item.disabled')).toBeVisible();
  await expect(page.locator('.skills-enable-toggle.disabled')).toBeVisible();
  await expect.poll(() => fs.existsSync(projected)).toBe(false);
  expect(fs.existsSync(sourceMarker)).toBe(true);

  // Re-enable → folder returns to the projected tree, marker cleared.
  await page.locator('.skills-enable-toggle').click();
  await expect(page.locator('.skills-list-item.disabled')).toHaveCount(0);
  await expect.poll(() => fs.existsSync(projected)).toBe(true);
  expect(fs.existsSync(sourceMarker)).toBe(false);
});

// Multi-file: a skill folder can bundle aux files (scripts/reference). The Files
// list is hidden until one exists; + File adds one, it becomes editable, the
// editor switches files, and × deletes it. See skills#8 + the manager-UI feature.
test('skills: add, edit, switch and delete an aux file', async ({ shelfApp }) => {
  const { page, app } = shelfApp;

  await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
  await page.locator('.skills-view .notes-new-btn').click();
  const ta = page.locator('.skills-view .notes-textarea');
  await expect(ta).toHaveValue(/name: my-skill/);

  // No aux files yet → the Files list is hidden.
  await expect(page.locator('.skills-files')).toHaveCount(0);

  // + File → type a path → Add. The Files list appears with SKILL.md + the file.
  await page.locator('.skills-addfile-btn').click();
  await page.locator('.skills-file-add-input').fill('scripts/build.sh');
  await page.locator('.skills-file-add-ok').click();
  await expect(page.locator('.skills-files')).toBeVisible();
  await expect(page.locator('.skills-file-name')).toHaveText(['SKILL.md', 'scripts/build.sh']);

  // The new file is selected + empty → write content, Save.
  await expect(page.locator('.skills-file-item.active .skills-file-name')).toHaveText('scripts/build.sh');
  await ta.fill('#!/bin/sh\necho building');
  await page.locator('.skills-view .notes-send-btn').click();
  await expect(page.locator('.skills-view .skills-error')).toHaveCount(0);

  // Switch back to SKILL.md → its content shows; switch to the script → persisted.
  await page.locator('.skills-file-item', { hasText: 'SKILL.md' }).click();
  await expect(ta).toHaveValue(/name: my-skill/);
  await page.locator('.skills-file-item', { hasText: 'scripts/build.sh' }).click();
  await expect(ta).toHaveValue('#!/bin/sh\necho building');

  // Delete the aux file → it leaves the list and the editor falls back to
  // SKILL.md. Electron's native confirm can't be driven through the page, so
  // patch dialog.showMessageBox in main to auto-return "OK" (response: 0).
  await app.evaluate(({ dialog }) => {
    (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await page.locator('.skills-file-item.active .skills-file-del').click();
  // It was the only aux file → the Files list auto-hides, editor falls back to SKILL.md.
  await expect(page.locator('.skills-files')).toHaveCount(0);
  await expect(ta).toHaveValue(/name: my-skill/);
});
