import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Sidebar worktree grouping — a project and its worktree children form ONE group
 * that renders together and reorders as a unit.
 *
 * Pure UI: projects are seeded directly (no git/worktree ops needed) so this
 * isolates the grouping/order behaviour from the create flow. The group-move math
 * itself is unit-tested (project-grouping.test.ts); this proves the wiring —
 * load normalization, indented child rendering, and group-granular drag.
 */

const A = 'grp-A';
const A_CHILD = 'grp-A-wt';
const B = 'grp-B';

function mkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-grp-'));
}

function seedProjects(userDataDir: string) {
  // Seeded OUT of grouped order (child last) to prove load-time normalization
  // pulls the child up under its parent.
  const projects = [
    { id: A, name: 'Alpha', cwd: mkdir(), connection: { type: 'local' }, maxTabs: 5 },
    { id: B, name: 'Bravo', cwd: mkdir(), connection: { type: 'local' }, maxTabs: 5 },
    {
      id: A_CHILD,
      name: 'Alpha',
      cwd: mkdir(),
      connection: { type: 'local' },
      maxTabs: 5,
      parentProjectId: A,
      worktreeBranch: 'feature/child',
      baseBranch: 'main',
    },
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

// Drag one sidebar row onto another via synthetic HTML5 drag events. Split into
// two evaluate ticks: dragstart must let React re-render (commit setDragIndex)
// BEFORE drop fires, or handleDrop's closure still reads the stale dragIndex and
// never reorders. A single-tick dispatch silently no-ops for that reason.
async function dragGroup(page: Page, srcSel: number, dstSel: number) {
  await page.evaluate((s) => {
    const src = document.querySelectorAll('.sidebar-item')[s];
    const dt = new DataTransfer();
    dt.setData('text/plain', String(s));
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  }, srcSel);
  await page.waitForTimeout(50);
  await page.evaluate((d) => {
    const dst = document.querySelectorAll('.sidebar-item')[d];
    const dt = new DataTransfer();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  }, dstSel);
}

test.describe('sidebar worktree grouping', () => {
  let userDataDir: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-grp-e2e-'));
    seedProjects(userDataDir);
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 10_000 });
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('child renders indented under its parent (order normalized on load)', async () => {
    const items = page.locator('.sidebar-item');
    await expect(items).toHaveCount(3, { timeout: 8_000 });

    // Grouped order: Alpha, its child, then Bravo — even though seeded child-last.
    await expect(items.nth(0)).toContainText('Alpha');
    await expect(items.nth(0)).not.toHaveClass(/worktree-child/);

    await expect(items.nth(1)).toHaveClass(/worktree-child/);
    await expect(items.nth(1)).toContainText('feature/child');
    // The child shows only its branch — never repeats the parent project name.
    await expect(items.nth(1)).not.toContainText('Alpha');
    // A child cannot start a drag; the whole group moves via the parent row.
    await expect(items.nth(1)).toHaveAttribute('draggable', 'false');

    await expect(items.nth(2)).toContainText('Bravo');
  });

  test('dragging the parent moves the whole group as a unit', async () => {
    const items = page.locator('.sidebar-item');
    await expect(items).toHaveCount(3, { timeout: 8_000 });

    // Drag Alpha (parent, idx 0) onto Bravo (idx 2): the whole Alpha group lands
    // after Bravo → Bravo, Alpha, feature/child.
    await dragGroup(page, 0, 2);
    await page.waitForTimeout(300);

    await expect(items.nth(0)).toContainText('Bravo');
    await expect(items.nth(1)).toContainText('Alpha');
    await expect(items.nth(1)).not.toHaveClass(/worktree-child/);
    await expect(items.nth(2)).toHaveClass(/worktree-child/);
    await expect(items.nth(2)).toContainText('feature/child');
  });
});
