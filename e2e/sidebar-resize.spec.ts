import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Draggable, persisted sidebar width.
 *
 * Drag the right-edge handle → the sidebar resizes live and the width is written
 * to settings.json on release; relaunching the app restores it. A seeded project
 * just gives the list something to render — the resize is independent of it.
 */

function seedProject(userDataDir: string) {
  const project = { id: 'sb-1', name: 'Sidebar Proj', cwd: os.tmpdir(), connection: { type: 'local' }, maxTabs: 5 };
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([project]), 'utf-8');
}

function readSidebarWidth(userDataDir: string): number | undefined {
  const p = path.join(userDataDir, 'settings.json');
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf-8')).sidebarWidth;
}

async function launch(userDataDir: string) {
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 10_000 });
  return { app, page };
}

async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator('.sidebar').boundingBox();
  if (!box) throw new Error('sidebar has no bounding box');
  return box.width;
}

test.describe('sidebar resize', () => {
  let userDataDir: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sbresize-'));
    seedProject(userDataDir);
    ({ app, page } = await launch(userDataDir));
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('dragging the handle resizes the sidebar and persists the width', async () => {
    expect(await sidebarWidth(page)).toBeCloseTo(220, 0);

    const handle = page.locator('.sidebar-resize-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle has no bounding box');

    // Drag the handle from ~220 out to ~320.
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(320, box.y + 120, { steps: 12 });
    await page.mouse.up();

    // Live width followed the drag.
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(300);
    // And the new width was persisted on release.
    await expect.poll(() => readSidebarWidth(userDataDir)).toBeGreaterThan(300);
  });

  test('persisted width is restored on relaunch', async () => {
    const handle = page.locator('.sidebar-resize-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(300, box.y + 120, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => readSidebarWidth(userDataDir)).toBeGreaterThan(280);

    await app.close();
    ({ app, page } = await launch(userDataDir));

    // The sidebar comes back at the persisted width, not the 220 default.
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(280);
  });

  test('width is clamped to a usable maximum', async () => {
    const handle = page.locator('.sidebar-resize-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle has no bounding box');
    // Drag far past the max (480).
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(900, box.y + 120, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => readSidebarWidth(userDataDir)).toBe(480);
    expect(await sidebarWidth(page)).toBeCloseTo(480, 0);
  });
});
