import { test, expect } from './helpers';

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
