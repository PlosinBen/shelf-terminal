import { expect, test } from './helpers';

async function renderedWidth(locator: import('@playwright/test').Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

async function dispatchDrag(
  page: import('@playwright/test').Page,
  handle: import('@playwright/test').Locator,
  startX: number,
  endX: number,
): Promise<void> {
  await handle.dispatchEvent('mousedown', { button: 0, clientX: startX });
  await page.evaluate((clientX) => {
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX }));
  }, endX);
}

test('Backup panel resizes, clamps, cleans up drag state, and resets on reopen', async ({ shelfApp: { page } }) => {
  await page.locator('.right-tab-btn[title="Backup"]').click();

  const panel = page.locator('.backup-view');
  const handle = panel.locator(':scope > .right-panel-resize-handle');
  await expect(panel).toBeVisible();
  await expect.poll(() => renderedWidth(panel)).toBe(400);

  await dispatchDrag(page, handle, 400, 300);
  await expect.poll(() => renderedWidth(panel)).toBe(500);
  await expect.poll(() => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }))).toEqual({ cursor: '', userSelect: '' });

  await dispatchDrag(page, handle, 400, -1000);
  await expect.poll(() => renderedWidth(panel)).toBe(700);

  await dispatchDrag(page, handle, 400, 1400);
  await expect.poll(() => renderedWidth(panel)).toBe(280);

  await handle.dispatchEvent('mousedown', { button: 0, clientX: 400 });
  await expect.poll(() => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }))).toEqual({ cursor: 'col-resize', userSelect: 'none' });

  await page.evaluate(() => {
    (document.querySelector('.backup-view .notes-close') as HTMLButtonElement).click();
  });
  await expect(panel).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }))).toEqual({ cursor: '', userSelect: '' });

  await page.locator('.right-tab-btn[title="Backup"]').click();
  await expect(panel).toBeVisible();
  await expect.poll(() => renderedWidth(panel)).toBe(400);
});
