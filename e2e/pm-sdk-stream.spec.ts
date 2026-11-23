import { test, expect } from './helpers';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

// Real bundled PM + SDK against an isolated loopback service, without credentials
// or Telegram. The readonly panel receives the same PM_SEND/PM_STREAM IPC path.
test.use({ homeProjectDirectories: false });

let server: Server;
let baseURL: string;
let requests: Array<{ url: string; body: any }>;
const chunk = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

test.beforeEach(async () => {
  requests = [];
  server = createServer(async (req, res) => {
    let input = '';
    for await (const piece of req) input += piece;
    const body = JSON.parse(input);
    requests.push({ url: req.url!, body });
    const prompt = body.messages?.findLast((m: any) => m.role === 'user')?.content;
    if (prompt === 'reject') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'PM fixture rejected request' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (prompt === 'cancel') {
      res.write(chunk({ content: 'Unfinished response' }));
      return; // Held open until PM_STOP aborts the request.
    }
    if (body.messages.at(-1).role !== 'tool') {
      res.end(chunk({ tool_calls: [{ index: 0, id: 'scan1', type: 'function', function: { name: 'scan_all_tabs', arguments: '{}' } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
    } else {
      res.end(chunk({ content: 'PM fixture finished' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function configure(page: import('@playwright/test').Page) {
  await page.evaluate(async url => {
    const settings = await window.shelfApi.settings.load();
    await window.shelfApi.settings.save({ ...settings, pmProvider: { provider: 'openai', apiKey: 'fixture-only', model: 'fixture', baseURL: url } });
  }, baseURL);
  await page.locator('.right-tab-btn', { hasText: 'PM' }).click();
  await expect(page.locator('.pm-panel')).toBeVisible();
}

test('PM SDK sends schemas and tool history, then persists the displayed reply', async ({ shelfApp: { page, userDataDir } }) => {
  await configure(page);
  await page.evaluate(() => window.shelfApi.pm.send('inspect'));
  await expect(page.locator('.pm-messages')).toContainText('PM fixture finished');
  expect(requests).toHaveLength(2);
  expect(requests.map(r => r.url)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
  const tool = requests[0].body.tools.find((t: any) => t.function.name === 'read_scrollback');
  expect(tool.function.parameters.required).toContain('tabId');
  expect(tool.function.parameters.properties.tabId.type).toBe('string');
  expect(requests[1].body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'scan1' });
  const saved = fs.readFileSync(path.join(userDataDir, 'pm-history.json'), 'utf8');
  expect(saved).toContain('PM fixture finished');
  await page.reload();
  await page.locator('.right-tab-btn', { hasText: 'PM' }).click();
  await expect(page.locator('.pm-messages')).toContainText('PM fixture finished');
});

test('PM SDK HTTP errors appear in the panel and persisted history without an empty success', async ({ shelfApp: { page, userDataDir } }) => {
  await configure(page);
  await page.evaluate(() => window.shelfApi.pm.send('reject'));
  await expect(page.locator('.pm-error')).toContainText('400: PM fixture rejected request');
  const history = await page.evaluate(() => window.shelfApi.pm.history());
  expect(history.map(m => m.role)).toEqual(['user', 'error']);
  expect(fs.readFileSync(path.join(userDataDir, 'pm-history.json'), 'utf8')).toContain('PM fixture rejected request');
  expect(requests).toHaveLength(1);
});

test('PM SDK stop closes streaming without saving an empty or partial success', async ({ shelfApp: { page } }) => {
  await configure(page);
  await page.evaluate(() => {
    (window as any).__pmPending = window.shelfApi.pm.send('cancel');
  });
  await expect.poll(() => requests.length).toBe(1);
  await page.evaluate(async () => {
    await window.shelfApi.pm.stop();
    await (window as any).__pmPending;
  });
  expect((await page.evaluate(() => window.shelfApi.pm.history())).map(m => m.role)).toEqual(['user']);
  await expect(page.locator('.pm-error')).toHaveCount(0);
  await expect(page.locator('.pm-msg-assistant')).toHaveCount(0);
});
