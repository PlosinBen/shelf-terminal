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
