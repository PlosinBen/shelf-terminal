import { test, expect, openAgentTab, readActiveTerminalText, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../src/shared/ipc-channels';

/**
 * Agent rendering flows beyond picker — exercises every other major wire
 * event the renderer must handle: permission_request, streaming chunks
 * pairing with finalize, fold cards (tool success + error), error events,
 * auth_required pane, and stop mid-execution.
 *
 * All driven via the fake provider (SHELF_TEST_MODE=1, see helpers.ts).
 * Scenarios documented in `agent-server/providers/fake.ts`.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  // setStep('browse') is synchronous but FolderPicker.tsx then kicks off an
  // async requestFolder → listDir. On slower hosts (Linux Electron, CI)
  // Cmd+Enter can fire before listDir lands → currentPath is still '' →
  // handleSelect falls back to the literal "project" name and an empty cwd →
  // agent-server later rejects sends with "Missing prompt or cwd". Wait for
  // the resolved path to populate before confirming.
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
}

async function storedAgentMessages(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shelf-agent-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<any[]>((resolve, reject) => {
        const request = database.transaction('messages').objectStore('messages').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}

test.describe('agent flows via fake provider', () => {
  test.describe('command result reading', () => {
    test.use({ homeProjectDirectories: false });

    test('structured outcomes hide success and preserve exceptions through history', async ({ shelfApp: { app, page } }) => {
      await setupProject(page);
      await app.evaluate(({ ipcMain }, channel) => {
        const original = (ipcMain as any)._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, payload) => {
          (globalThis as any).__outcomeTab = payload.tabId;
          return original(event, payload);
        });
      }, IPC.AGENT_INIT);
      await openAgentTab(page);
      await app.evaluate(({ BrowserWindow }, channel) => {
        const target = BrowserWindow.getAllWindows()[0].webContents;
        const tabId = (globalThis as any).__outcomeTab;
        const send = (id: string, execution?: unknown, body = 'partial output') => target.send(channel, tabId, {
          type: 'fold_code', msgId: id, label: id, body: { content: body }, ...(execution ? { execution } : {}),
        });
        send('outcome-ok', { state: 'succeeded', exitCode: 0 }, '');
        send('outcome-ok-output', { state: 'succeeded' }, 'successful output');
        send('outcome-failed', { state: 'failed', exitCode: 130 });
        send('outcome-failed', { state: 'running' }, 'partial output\nlate output');
        send('outcome-declined', { state: 'declined' }, '');
        send('outcome-interrupted', { state: 'interrupted' });
        send('outcome-pending', { state: 'pending' });
        send('outcome-running', { state: 'running' });
        send('outcome-malformed', { state: 'succeeded', exitCode: '0' });
        send('outcome-legacy');
      }, IPC.AGENT_MESSAGE);
      const card = (name: string) => page.locator('.agent-msg-fold').filter({ has: page.locator('.fold-label', { hasText: new RegExp(`^${name}$`) }) });
      const expectResults = async () => {
        await expect(card('outcome-ok').locator('.fold-execution')).toHaveCount(0);
        await expect(card('outcome-ok-output').locator('.fold-execution')).toHaveCount(0);
        await expect(card('outcome-failed').locator('.fold-execution')).toHaveText('Failed · exit 130');
        await expect(card('outcome-declined').locator('.fold-execution')).toHaveText('Not executed: declined');
        await expect(card('outcome-interrupted').locator('.fold-execution')).toHaveText('Interrupted');
        await expect(card('outcome-malformed').locator('.fold-execution')).toHaveText('Result unknown');
        await expect(card('outcome-legacy').locator('.fold-execution')).toHaveCount(0);
      };
      await expectResults();
      await card('outcome-ok-output').locator('.fold-header').click();
      await expect(card('outcome-ok-output').locator('.fold-body-code')).toHaveText('successful output');
      await expect(card('outcome-ok-output').locator('.fold-execution')).toHaveCount(0);
      await expect(card('outcome-pending').locator('.fold-execution')).toHaveText('Waiting');
      await expect(card('outcome-running').locator('.fold-execution')).toHaveText('Running');
      await expect(card('outcome-failed').locator('.fold-body-code')).toContainText('late output');
      await card('outcome-failed').locator('.fold-header').click();
      await expect(card('outcome-failed').locator('.fold-body-code')).toHaveCount(0);
      await expect(card('outcome-failed').locator('.fold-execution')).toBeVisible();
      await expect.poll(async () => (await storedAgentMessages(page)).filter(m => m.id.startsWith('outcome-')).length,
        { timeout: 15000 }).toBe(9);
      expect((await storedAgentMessages(page)).find(m => m.id === 'outcome-ok')).toMatchObject({ execution: { state: 'succeeded', exitCode: 0 } });
      await page.locator('.tab-bar .tab.active').click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Save to Default', exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.shelfApi.project.getAll()))[0].defaultTabs.some(t => t.kind === 'agent')).toBe(true);
      await page.locator('.sidebar-item').first().click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Disconnect', exact: true }).click();
      await expect(page.locator('.connect-prompt')).toBeVisible();
      await page.locator('.connect-prompt').click();
      await page.locator('.tab-bar .tab').last().click();
      await expectResults();
      await expect(card('outcome-pending').locator('.fold-execution')).toHaveText('Result unknown');
      await expect(card('outcome-running').locator('.fold-execution')).toHaveText('Result unknown');
      await expect(card('outcome-running').locator('.fold-body-code')).toHaveText('partial output');
    });

    test('failed output can collapse, reveal the tail and copy complete received text', async ({ shelfApp: { app, page } }) => {
      await setupProject(page);
      await app.evaluate(({ ipcMain }, channel) => {
        const original = (ipcMain as any)._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, payload) => {
          (globalThis as any).__commandReadingTab = payload.tabId;
          return original(event, payload);
        });
      }, IPC.AGENT_INIT);
      await openAgentTab(page);
      const command = '/bin/zsh -lc \'printf "first; line"\nfalse\'';
      const output = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n') + '\n<failure-at-tail>';
      const sendCard = async (failed: boolean, content = output) => app.evaluate(({ BrowserWindow }, { channel, command, output, failed }) => {
        BrowserWindow.getAllWindows()[0].webContents.send(channel, (globalThis as any).__commandReadingTab, {
          type: 'fold_code', msgId: 'command-reading', label: 'Command', subtitle: command,
          body: { content: output }, ...(failed ? { errorMessage: 'Command failed with exit code 1' } : {}),
        });
      }, { channel: IPC.AGENT_MESSAGE, command, output: content, failed });
      await sendCard(false, 'alpha');
      const card = page.locator('.agent-msg-fold').filter({ has: page.locator('.fold-label', { hasText: 'Command' }) });
      const header = card.locator('.fold-header');
      await header.click();
      await expect(card.locator('.fold-body-code')).toBeVisible();
      await expect(card.locator('.fold-command-text')).toHaveText(command);
      const expectCopyAligned = async () => {
        for (const block of await card.locator('.fold-body-container').all()) {
          const offset = await block.evaluate(el => {
            const pre = el.querySelector('pre')!;
            const button = el.querySelector('button')!;
            const style = getComputedStyle(pre);
            const firstLineCenter = pre.getBoundingClientRect().top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
            const rect = button.getBoundingClientRect();
            return Math.abs(rect.top + rect.height / 2 - firstLineCenter);
          });
          expect(offset).toBeLessThan(1);
        }
      };
      await expectCopyAligned();
      const colors = await card.evaluate(el => {
        const style = getComputedStyle(el);
        return { muted: style.getPropertyValue('--text-muted').trim(), text: style.getPropertyValue('--text').trim() };
      });
      const resolvedColor = async (value: string) => page.evaluate(value => {
        const el = document.createElement('span');
        el.style.color = value;
        document.body.append(el);
        const color = getComputedStyle(el).color;
        el.remove();
        return color;
      }, value);
      await expect(card.locator('.fold-command-text')).toHaveCSS('color', await resolvedColor(colors.muted));
      await expect(card.locator('.fold-body-code')).toHaveCSS('color', await resolvedColor(colors.text));
      const detailsBox = await card.locator('.fold-command-text').boundingBox();
      const outputBox = await card.locator('.fold-body-code').boundingBox();
      expect(outputBox!.y - detailsBox!.y - detailsBox!.height).toBeCloseTo(12, 0);
      await expect(header.locator('.fold-subtitle')).toHaveCount(0);
      await expect(card.getByRole('button', { name: /^(Show|Hide) details$/ })).toHaveCount(0);
      await header.click();
      await expect(header.locator('.fold-subtitle')).toHaveText(command);
      await expect(card.locator('.fold-command-text')).toHaveCount(0);
      await sendCard(true);
      await expect(card.locator('.fold-body-code')).toBeVisible();
      await expect(card.locator('.fold-reading-controls')).toHaveCSS('margin-top', '12px');
      await expectCopyAligned();
      await header.click();
      await expect(card.locator('.fold-body-code')).toHaveCount(0);
      await expect(card.locator('.fold-error-banner')).toBeVisible();
      await sendCard(true);
      await expect(card.locator('.fold-body-code')).toHaveCount(0);
      await header.focus();
      await page.keyboard.press('Enter');
      await expect(card.locator('.fold-body-code')).not.toContainText('<failure-at-tail>');
      const copyOutput = card.locator('.fold-body-container').getByRole('button', { name: 'Copy output', exact: true });
      await expect(copyOutput).toBeVisible();
      await expect(copyOutput).toHaveText('');
      const heightBeforeCopy = (await card.boundingBox())!.height;
      await copyOutput.click();
      await expect(copyOutput).toHaveAttribute('data-copied', 'true');
      await expect(copyOutput.locator('svg rect')).toHaveCount(0);
      await expect(card.getByRole('status')).toHaveCount(0);
      expect((await card.boundingBox())!.height).toBe(heightBeforeCopy);
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(output);
      await expect(copyOutput).toHaveAttribute('data-copied', 'false');
      await expect(copyOutput.locator('svg rect')).toHaveCount(1);
      await card.getByRole('button', { name: 'View tail', exact: true }).click();
      await expect(card.locator('.fold-body-code')).toHaveText(output);
      await expect.poll(() => card.locator('.fold-body-code').evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true);
      await card.getByRole('button', { name: 'Copy output', exact: true }).click();
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(output);
      await card.getByRole('button', { name: 'Show preview', exact: true }).click();
      await expect(card.locator('.fold-body-code')).not.toContainText('<failure-at-tail>');
      await card.getByRole('button', { name: 'Show full output (46 lines)', exact: true }).click();
      await expect(card.locator('.fold-body-code')).toHaveText(output);
      await expect(card.locator('.fold-command-text')).toHaveText(command);
      const copyDetails = card.locator('.fold-body-container').getByRole('button', { name: 'Copy details', exact: true });
      await expect(copyDetails).toHaveText('');
      await copyDetails.focus();
      await page.keyboard.press('Enter');
      await expect(copyDetails).toHaveAttribute('data-copied', 'true');
      await expect(card.getByRole('status')).toHaveCount(0);
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(command);
      await expect(card.locator('.fold-body-code')).toBeVisible();
      // Copy errors must be visible without losing the received content.
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); }; });
      await card.getByRole('button', { name: 'Copy output', exact: true }).click();
      await expect(card.getByRole('status')).toContainText('Could not copy output');
      await expect(copyOutput).toHaveAttribute('data-copied', 'false');
      await expect(card.locator('.fold-body-code')).toHaveText(output);
      await header.focus();
      await page.keyboard.press('Space');
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await expect(card.locator('.fold-error-banner')).toBeVisible();
      await expect.poll(async () => (await storedAgentMessages(page)).find(m => m.id === 'command-reading')?.body?.content,
        { timeout: 15000 }).toBe(output);
      await page.locator('.tab-bar .tab.active').click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Save to Default', exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.shelfApi.project.getAll()))[0].defaultTabs.some(t => t.kind === 'agent')).toBe(true);
      await page.locator('.sidebar-item').first().click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Disconnect', exact: true }).click();
      await expect(page.locator('.connect-prompt')).toBeVisible();
      await page.locator('.connect-prompt').click();
      await page.locator('.tab-bar .tab').last().click();
      // Expansion is deliberately mount-local; failure and full received output survive history reload.
      await expect(card.locator('.fold-body-code')).toBeVisible();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      await card.getByRole('button', { name: 'Show full output (46 lines)', exact: true }).click();
      await expect(card.locator('.fold-body-code')).toHaveText(output);
      await app.evaluate(({ BrowserWindow }, channel) => {
        BrowserWindow.getAllWindows()[0].webContents.send(channel, (globalThis as any).__commandReadingTab, {
          type: 'fold_code', msgId: 'empty-reading', label: 'Read', body: { content: '' },
        });
      }, IPC.AGENT_MESSAGE);
      const emptyCard = page.locator('.agent-msg-fold').filter({ has: page.locator('.fold-label', { hasText: /^Read$/ }) });
      await emptyCard.locator('.fold-header').click();
      await expect(emptyCard.locator('.fold-body-code')).toHaveCount(0);
      await expect(emptyCard.getByRole('button', { name: 'Copy output', exact: true })).toHaveCount(0);
    });
  });
  // Seed historical internal inputs through the actual main→renderer bridge;
  // this verifies rendering/storage, not live Telegram routing or authorization.
  test('shows saved input sources after reconnect without inferring legacy or human sources', async ({ shelfApp: { app, page } }) => {
    await setupProject(page);
    await app.evaluate(({ ipcMain }, channel) => {
      const original = (ipcMain as any)._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, payload) => {
        (globalThis as any).__sourceViewTabId = payload.tabId;
        return original(event, payload);
      });
    }, IPC.AGENT_INIT);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'text:ordinary human input');
    await app.evaluate(({ BrowserWindow }, channel) => {
      const tabId = (globalThis as any).__sourceViewTabId;
      const target = BrowserWindow.getAllWindows()[0].webContents;
      for (const [id, content, source] of [
        ['legacy-source', 'Legacy from Telegram without metadata', null],
        ['telegram-source', 'saved Telegram input', { kind: 'telegram' }],
        ['agent-source', 'saved collaborator input', { kind: 'agent', agentViewId: 'historical-view', displayName: 'Research at send time' }],
      ] as const) {
        target.send(channel, tabId, { type: 'user', msgId: id, content,
          ...(source ? { inputMessage: { msgId: id, source, content, attachments: [], replyRequirement: 'none' } } : {}) });
      }
    }, IPC.AGENT_MESSAGE);
    const assertSources = async () => {
      const users = page.locator('.agent-msg-user:visible');
      await expect(users.filter({ hasText: 'ordinary human input' }).locator('.agent-msg-source')).toHaveCount(0);
      await expect(users.filter({ hasText: 'Legacy from Telegram without metadata' }).locator('.agent-msg-source')).toHaveCount(0);
      await expect(users.filter({ hasText: 'saved Telegram input' }).locator('.agent-msg-source')).toHaveText('Telegram');
      await expect(users.filter({ hasText: 'saved collaborator input' }).locator('.agent-msg-source')).toHaveText('From Research at send time');
    };
    await assertSources();
    await expect.poll(async () => (await storedAgentMessages(page)).filter(m => ['telegram-source', 'agent-source'].includes(m.id)).length, { timeout: 15000 }).toBe(2);
    await page.locator('.tab-bar .tab.active').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Save to Default', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.shelfApi.project.getAll()))[0].defaultTabs.some(t => t.kind === 'agent')).toBe(true);
    await page.locator('.sidebar-item').first().click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Disconnect', exact: true }).click();
    await expect(page.locator('.connect-prompt')).toBeVisible();
    await page.locator('.connect-prompt').click();
    await page.locator('.tab-bar .tab').last().click();
    await assertSources();
  });

  // The actual IPC must settle on queue receipt while the model is still working.
  // A background runner, not the invoking renderer, owns execution afterwards.
  test('acknowledges running and queued submissions before execution finishes', async ({ shelfApp: { app, page } }) => {
    await setupProject(page);
    await app.evaluate(({ ipcMain }, channel) => {
      const original = (ipcMain as any)._invokeHandlers.get(channel);
      (globalThis as any).__submissionResults = [];
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, payload) => {
        const result = await original(event, payload);
        (globalThis as any).__submissionResults.push(result);
        return result;
      });
    }, IPC.AGENT_SEND);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'delay:10000|text:first completed');
    await expect.poll(() => app.evaluate(() => (globalThis as any).__submissionResults), { timeout: 3000 }).toEqual([{ ok: true }]);
    await sendAgentPrompt(page, 'text:second completed');
    await expect.poll(() => app.evaluate(() => (globalThis as any).__submissionResults), { timeout: 3000 }).toEqual([{ ok: true }, { ok: true }]);
    await expect(page.locator('.agent-msg-queued')).toHaveCount(1);
    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'first completed' })).toHaveCount(0);
    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'second completed' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
  });

  test('shows typed submission rejection in the originating View and removes its unsent chip', async ({ shelfApp: { app, page } }) => {
    await setupProject(page); await openAgentTab(page);
    await app.evaluate(({ ipcMain }, channel) => {
      const original = (ipcMain as any)._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      // Exercise real main validation/target lookup; only the target disappears.
      ipcMain.handle(channel, (event, payload) => original(event, { ...payload, tabId: 'closed-view' }));
    }, IPC.AGENT_SEND);
    await sendAgentPrompt(page, 'text:cannot reach target');
    await expect(page.locator('.agent-messages:visible')).toContainText('Input submission failed (target_missing)');
    await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
    await expect(page.locator('.agent-msg-reply:visible')).toHaveCount(0);
  });

  test('preserves original input and canonical message metadata through queue and history', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    const original = '  text:canonical input  ';
    await sendAgentPrompt(page, original);
    await expect(page.locator('.agent-messages:visible')).toContainText('canonical input');
    // Check the persisted result, not only the optimistic renderer bubble.
    // Production batches history writes for 5s; polling must outlive that timer.
    await expect.poll(async () => {
      const row = (await storedAgentMessages(page)).find(row => row.type === 'user' && row.content === original);
      return row ? { idMatches: row.id === `user-${row.inputMessage?.msgId}`, message: row.inputMessage } : null;
    }, { timeout: 15_000 }).toEqual({
      idMatches: true,
      message: { msgId: expect.any(String), source: { kind: 'agent-view' }, content: original, attachments: [], replyRequirement: 'none' },
    });
    await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
    await sendAgentPrompt(page, '  /mcp  ');
    await expect(page.locator('.agent-messages:visible')).toContainText('2 MCP servers');
  });

  test('sends attachment-only input with uploaded metadata and local history preview', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await page.locator('.agent-textarea:visible').evaluate(target => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      transfer.items.add(new File(['hello-file'], 'note.txt', { type: 'text/plain' }));
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.agent-attachment-chip')).toHaveCount(2);
    // Use the normal driver (click/fill/Enter), including for an empty body.
    await sendAgentPrompt(page, '');
    await expect(page.locator('.agent-attachment-chip')).toHaveCount(0);
    await expect.poll(async () => {
      const row = (await storedAgentMessages(page)).find(row => row.type === 'user' && row.content === '');
      return row?.inputMessage?.attachments;
    }, { timeout: 15_000 }).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file', name: 'note.txt', path: expect.any(String), size: 10 }),
      expect.objectContaining({ kind: 'image', name: 'shot.png', path: expect.any(String), mimeType: 'image/png', size: expect.any(Number) }),
    ]));
    const row = (await storedAgentMessages(page)).find(row => row.type === 'user' && row.content === '');
    expect(row.images).toEqual([expect.stringMatching(/^data:image\/png;base64,/)]);
    expect(fs.readFileSync(row.inputMessage.attachments.find((a: any) => a.kind === 'file').path, 'utf8')).toBe('hello-file');
    await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
    await sendAgentPrompt(page, 'text:usable after attachments');
    await expect(page.locator('.agent-messages:visible')).toContainText('usable after attachments');
  });

  test.describe('provider-native permission controls', () => {
    test.use({ nativePermissions: true, homeProjectDirectories: false });
    test.afterEach(async ({ shelfApp: { userDataDir } }, info) => {
      const root = path.join(userDataDir, 'logs');
      if (info.status !== info.expectedStatus && fs.existsSync(root)) {
        const logs = fs.readdirSync(root, { recursive: true }).filter(name => String(name).endsWith('.log'));
        for (const name of logs) await info.attach('main-log', { body: fs.readFileSync(path.join(root, String(name))), contentType: 'text/plain' });
      }
    });

    test('records a live model setting in the timeline without interrupting work', async ({ shelfApp: { page } }) => {
      await setupProject(page); await openAgentTab(page);
      await page.evaluate(async () => { const settings = await window.shelfApi.settings.load(); await window.shelfApi.settings.save({ ...settings, logLevel: 'debug' }); });
      await sendAgentPrompt(page, 'delay:4000|text:original work completed');
      await expect(page.locator('.agent-status-label:visible')).toHaveText('running');
      const users = page.locator('.agent-messages:visible .agent-msg-user');
      await expect(users).toHaveCount(1);
      await page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'fake-model' }).click();
      await page.locator('.agent-perm-option:visible', { hasText: 'fake-model-pro' }).click();
      await expect(page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'fake-model-pro' })).toHaveText('fake-model-pro', { timeout: 2000 });
      await expect(page.locator('.agent-config-feedback')).toHaveCount(0);
      await expect(page.locator('.agent-status-label:visible')).toHaveText('running');
      await expect(users).toHaveCount(1);
      await expect(page.locator('.agent-messages:visible .agent-msg-system').filter({ hasText: 'Model set to fake-model-pro' })).toHaveCount(1);
      await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
      await expect.poll(async () => {
        const project = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
        return Object.values(project.agentViews).some(view => view.prefs.model === 'fake-model-pro');
      }).toBe(true);
      await expect(page.locator('.agent-messages:visible')).toContainText('original work completed');
      await expect.poll(async () => (await storedAgentMessages(page)).filter(row =>
        row.type === 'system' && row.content === 'Model set to fake-model-pro (applies on next query)').length).toBe(1);
    });

    test('defers effort ahead of queued messages while slash picker remains ordinary input', async ({ shelfApp: { page } }) => {
      await setupProject(page); await openAgentTab(page);
      await sendAgentPrompt(page, 'delay:3500|text:first work completed');
      await page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'effort:' }).click();
      await page.locator('.agent-perm-option:visible', { hasText: 'high' }).click();
      await expect(page.locator('.agent-config-feedback')).toHaveAttribute('data-state', 'deferred');
      await expect(page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'fake-model' })).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'effort:' })).toHaveText('effort: medium');
      await sendAgentPrompt(page, '/model');
      await page.locator('.agent-perm-option:visible', { hasText: 'fake-model-pro' }).click();
      await expect(page.locator('.agent-msg-queued')).toContainText('/model fake-model-pro');
      await expect(page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'effort:' })).toHaveText('effort: high');
      await expect(page.locator('.agent-config-feedback')).toHaveCount(0);
      await expect(page.locator('.agent-messages:visible .agent-msg-user').filter({ hasText: '/model fake-model-pro' })).toHaveCount(1);
      await expect(page.locator('.agent-messages:visible')).toContainText('Model set to fake-model-pro');
      await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
    });

    test('stop rejects a deferred setting without blocking the next message', async ({ shelfApp: { page } }) => {
      await setupProject(page); await openAgentTab(page);
      await sendAgentPrompt(page, 'delay:10000|text:work before stop');
      await expect(page.locator('.agent-status-label:visible')).toHaveText('running');
      await page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'effort:' }).click();
      await page.locator('.agent-perm-option:visible', { hasText: 'high' }).click();
      await expect(page.locator('.agent-config-feedback')).toHaveAttribute('data-state', 'deferred');
      await page.locator('.agent-textarea:visible').focus();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
      await expect(page.locator('.agent-config-feedback')).toHaveAttribute('data-state', 'rejected');
      await expect(page.locator('.agent-config-feedback')).toContainText('not applied');
      await expect(page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'effort:' })).toHaveText('effort: medium');
      await sendAgentPrompt(page, 'text:usable after stopping pending configuration');
      await expect(page.locator('.agent-messages:visible')).toContainText('usable after stopping pending configuration');
      await expect(page.locator('.agent-messages:visible')).not.toContainText('Session configuration is uncertain');
    });

    test('shows uncertain config outside the timeline and reconnects without resending it', async ({ shelfApp: { page } }) => {
      await setupProject(page); await openAgentTab(page);
      await page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'fake-model' }).click();
      await page.locator('.agent-perm-option:visible', { hasText: 'Unconfirmed model (test)' }).click();
      await expect(page.locator('.agent-config-feedback')).toHaveAttribute('data-state', 'uncertain');
      await expect(page.locator('.agent-config-feedback')).toContainText('Fake configuration was not confirmed');
      await expect(page.locator('.agent-messages:visible')).not.toContainText('Fake configuration was not confirmed');
      await expect(page.locator('.agent-msg-system').filter({ hasText: 'Model set to' })).toHaveCount(0);
      // Session restart is the existing user-owned recovery surface. A new View
      // must read confirmed prefs, never the failed requested value.
      await page.locator('.agent-config-feedback button', { hasText: 'Reconnect' }).click();
      await expect(page.locator('.agent-config-feedback')).toHaveCount(0);
      await expect(page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'fake-model' })).toBeVisible();
      await sendAgentPrompt(page, 'text:usable after reconnect');
      await expect(page.locator('.agent-messages:visible')).toContainText('usable after reconnect');
    });

    test('rejects a config control without changing confirmed settings or blocking messages', async ({ shelfApp: { page } }) => {
      await setupProject(page); await openAgentTab(page);
      const model = page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'fake-model' });
      await model.click();
      await page.locator('.agent-perm-option:visible', { hasText: 'Rejected model (test)' }).click();
      await expect(page.locator('.agent-config-feedback')).toHaveAttribute('data-state', 'rejected');
      await expect(model).toHaveText('fake-model');
      await expect(page.locator('.agent-messages:visible')).not.toContainText('Fake configuration rejected');
      await sendAgentPrompt(page, 'text:usable after rejection');
      await expect(page.locator('.agent-messages:visible')).toContainText('usable after rejection');
    });

    test('shows and mutates mode and permission independently', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      const mode = page.locator('[data-config-key="nativeMode"]:visible');
      const permission = page.locator('[data-config-key="nativePermission"]:visible');
      await expect(mode).toHaveText('Mode: Agent');
      await expect(permission).toHaveText('Allow all: Off');

      await mode.click();
      await expect(page.locator('.agent-permission-header:visible')).toHaveText('Select Mode');
      await page.locator('.agent-perm-option:visible', { hasText: 'Plan' }).click();
      await expect(mode).toHaveText('Mode: Plan', { timeout: 5_000 });
      await expect(permission).toHaveText('Allow all: Off');

      await mode.click();
      await page.locator('.agent-perm-option:visible', { hasText: 'Autopilot' }).click();
      await expect(mode).toHaveText('Mode: Autopilot', { timeout: 5_000 });

      await permission.click();
      await expect(page.locator('.agent-permission-header:visible')).toHaveText('Select Allow all');
      await page.locator('.agent-perm-option:visible', { hasText: 'On' }).click();
      await expect(permission).toHaveText('Allow all: On', { timeout: 5_000 });
      await expect(mode).toHaveText('Mode: Autopilot');
    });

    test('retains confirmed model, effort, mode, and permission after disconnect and reconnect', async ({ shelfApp: { page, userDataDir } }) => {
      await setupProject(page);
      await openAgentTab(page);

      const model = page.locator('.agent-status-seg.agent-status-interactive', { hasText: 'fake-model' });
      const effort = page.locator('.agent-status-seg.agent-status-interactive', { hasText: 'effort:' });
      const mode = page.locator('[data-config-key="nativeMode"]:visible');
      const permission = page.locator('[data-config-key="nativePermission"]:visible');

      await model.click();
      await page.locator('.agent-perm-option:visible', { hasText: 'fake-model-pro' }).click();
      await effort.click();
      await page.locator('.agent-perm-option:visible', { hasText: 'High' }).click();
      await mode.click();
      await page.locator('.agent-perm-option:visible', { hasText: 'Plan' }).click();
      await permission.click();
      await page.locator('.agent-perm-option:visible', { hasText: 'On' }).click();

      await expect(model).toHaveText('fake-model-pro');
      await expect(effort).toHaveText('effort: high');
      await expect(mode).toHaveText('Mode: Plan');
      await expect(permission).toHaveText('Allow all: On');
      await expect.poll(() => {
        const document = JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf8'));
        return Object.values(document.projects[0].agentViews)[0].prefs;
      }).toEqual({
        model: 'fake-model-pro',
        effort: 'high',
        nativeMode: 'plan',
        nativePermission: 'on',
      });

      // Ordinary input must preserve live settings without carrying/replaying prefs.
      await sendAgentPrompt(page, 'text:settings remain active');
      await expect(page.locator('.agent-msg:visible').last()).toContainText('settings remain active');
      await expect(effort).toHaveText('effort: high');
      await expect(mode).toHaveText('Mode: Plan');

      // The post-auth probe must read the latest persisted intent as well.
      await sendAgentPrompt(page, 'auth_required');
      const auth = page.locator('.agent-auth-pane:visible');
      await expect(auth).toBeVisible();
      await auth.locator('.agent-reset-btn', { hasText: 'Retry' }).click();
      await expect(auth).toHaveCount(0);
      await expect(model).toHaveText('fake-model-pro');
      await expect(effort).toHaveText('effort: high');
      await expect(mode).toHaveText('Mode: Plan');
      await expect(permission).toHaveText('Allow all: On');

      await page.locator('.tab-bar .tab').last().click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Save to Default', exact: true }).click();
      const item = page.locator('.sidebar-item').first();
      await item.click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Disconnect' }).click();
      const prompt = page.locator('.connect-prompt');
      await expect(prompt).toBeVisible({ timeout: 5_000 });
      await prompt.click();
      await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
      await page.locator('.tab-bar .tab').nth(1).click();

      await expect(page.locator('.agent-status-seg.agent-status-interactive', { hasText: 'fake-model-pro' })).toBeVisible();
      await expect(page.locator('.agent-status-seg.agent-status-interactive', { hasText: 'effort: high' })).toBeVisible();
      await expect(page.locator('[data-config-key="nativeMode"]:visible')).toHaveText('Mode: Plan');
      await expect(page.locator('[data-config-key="nativePermission"]:visible')).toHaveText('Allow all: On');
    });
  });

  test.describe('native approval and explicit prefs', () => {
    test.use({ nativePermissions: true, nativeApproval: true });
    test('keeps defaults unpinned and custom approval independent of mode and effort', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      const approval = page.locator('[data-config-key="nativeApproval"]:visible');
      await expect(approval).toHaveText('Approval: Custom');
      expect(await page.evaluate(async () => Object.values((await window.shelfApi.project.getAll())[0].agentViews)[0].prefs ?? {})).toEqual({});
      await page.locator('[data-config-key="nativeMode"]:visible').click();
      await page.locator('.agent-perm-option:visible', { hasText: 'Plan' }).click();
      await expect(page.locator('[data-config-key="nativeMode"]:visible')).toHaveText('Mode: Plan');
      await expect(approval).toHaveText('Approval: Custom');
      await expect(page.locator('.agent-status-seg.agent-status-interactive', { hasText: 'effort:' })).toHaveText('effort: medium');
      await approval.click();
      await expect(page.locator('.agent-perm-option:visible')).toHaveCount(3);
      await page.locator('.agent-perm-option:visible', { hasText: 'never' }).click();
      await expect(approval).toHaveText('Approval: never');
      await expect.poll(() => page.evaluate(async () => Object.values((await window.shelfApi.project.getAll())[0].agentViews)[0].prefs)).toEqual({ nativeMode: 'plan', nativeApproval: 'never' });
    });
  });

  test.describe('add-tab menu', () => {
    test('lists every provider from the single-source registry', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await page.locator('.tab-add').click({ button: 'right' });
      const menu = page.locator('.context-menu');
      await expect(menu).toBeVisible({ timeout: 5_000 });
      // One button per registry entry. Post-cutover: `copilot` IS the ACP backend
      // (no separate "Copilot ACP · dev" entry).
      for (const label of ['Agent (Claude)', 'Agent (Copilot)', 'Agent (Codex)', 'Agent (Test Agent)']) {
        await expect(menu.locator('.context-menu-item', { hasText: label })).toBeVisible();
      }
      await expect(menu.locator('.context-menu-item', { hasText: 'Copilot ACP' })).toHaveCount(0);
    });

    test('opens the explicitly selected provider and keeps open providers available until the tab limit', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      const providers = [
        { menu: 'Agent (Claude)', tab: 'Claude' },
        { menu: 'Agent (Copilot)', tab: 'Copilot' },
        { menu: 'Agent (Codex)', tab: 'Codex' },
        { menu: 'Agent (Test Agent)', tab: 'Test Agent' },
      ];

      for (const [index, provider] of providers.entries()) {
        await page.locator('.tab-add').click({ button: 'right' });
        await page.locator('.context-menu-item', { hasText: provider.menu }).click();
        const openedTab = page.locator('.tab-bar .tab', { hasText: provider.tab });
        await expect(openedTab).toHaveCount(1, { timeout: 5_000 });

        if (index < providers.length - 1) {
          await page.locator('.tab-add').click({ button: 'right' });
          // A provider is not a singleton: another View may use it. The total
          // tab limit, not the provider identity, controls whether tabs can open.
          await expect(page.locator('.context-menu-item', { hasText: provider.menu })).toBeEnabled();
          await openedTab.click();
        }
      }

      await expect(page.locator('.tab-bar .tab')).toHaveCount(5);
      await expect(page.locator('.tab-add')).toBeDisabled();
    });

    test('opens independent Views of the same provider from the add-tab menu', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'text:first-view-only');
      await expect(page.locator('.agent-msg-reply:visible').last()).toContainText('first-view-only');

      await page.locator('.tab-add').click({ button: 'right' });
      const sameProvider = page.locator('.context-menu-item', { hasText: 'Agent (Claude)', exact: true });
      await expect(sameProvider).toBeEnabled();
      await sameProvider.click();
      const views = page.locator('.tab-bar .tab', { hasText: 'Claude' });
      await expect(views).toHaveCount(2);
      await expect(page.locator('.agent-msg:visible')).toHaveCount(0);
      await sendAgentPrompt(page, 'text:second-view-only');
      await expect(page.locator('.agent-msg-reply:visible').last()).toContainText('second-view-only');
      await expect(page.locator('.agent-messages:visible')).not.toContainText('first-view-only');

      await views.first().click();
      await expect(page.locator('.agent-msg-reply:visible').last()).toContainText('first-view-only');
      await expect(page.locator('.agent-messages:visible')).not.toContainText('second-view-only');
    });

    test('renders an internal provider name outside assistant replies', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await page.locator('.tab-add').click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Agent (Test Agent)' }).click();

      await expect(page.locator('.tab-bar .tab', { hasText: 'Test Agent' })).toBeVisible();
      await expect(page.locator('.agent-status-bar:visible')).toContainText('Test Agent');

      await sendAgentPrompt(page, 'text:label-source');
      await expect(page.locator('.agent-msg-reply:visible').last().locator('.agent-msg-label'))
        .toHaveCount(0);
    });
  });

  test.describe('permission', () => {
    test('Allow once → tool runs, success system message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'permission:Bash');

      const panel = page.locator('.agent-permission:visible');
      await expect(panel).toBeVisible({ timeout: 5_000 });
      await expect(panel).toContainText('Bash');

      await panel.locator('.agent-perm-option', { hasText: 'Allow once' }).click();
      await expect(page.locator('.agent-messages:visible')).toContainText('permission allowed: Bash', { timeout: 5_000 });
    });

    test('Deny → deny system message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'permission:Write');

      const panel = page.locator('.agent-permission:visible');
      await expect(panel).toBeVisible({ timeout: 5_000 });
      await panel.locator('.agent-perm-option', { hasText: 'Deny' }).click();

      await expect(page.locator('.agent-messages:visible')).toContainText('permission denied: Write', { timeout: 5_000 });
    });
  });

  test.describe('streaming', () => {
    test('text stream chunks finalize into a single message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // Two stream chunks → one finalize. After settling we expect the
      // finalized message present with the full content (upsert behavior:
      // chunks share msgId with finalize, no duplication).
      await sendAgentPrompt(page, 'text:hello world');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('hello world', { timeout: 5_000 });

      // Status should drop to idle after the execution completes.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    });

    test('auto-follow scrolls only the message history', async ({ shelfApp: { page } }) => {
      await page.evaluate(() => {
        const trackedWindow = window as typeof window & { __agentScrollIntoViewCalls?: number };
        trackedWindow.__agentScrollIntoViewCalls = 0;
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
          if (this.parentElement?.classList.contains('agent-messages')) {
            trackedWindow.__agentScrollIntoViewCalls = (trackedWindow.__agentScrollIntoViewCalls ?? 0) + 1;
          }
          original.call(this, arg);
        };
      });
      await setupProject(page);
      await openAgentTab(page);

      const longReply = Array.from({ length: 100 }, (_, index) => `history-line-${index}`).join('\n');
      await sendAgentPrompt(page, `text:${longReply}`);

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('history-line-99', { timeout: 5_000 });
      await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => (
        window as typeof window & { __agentScrollIntoViewCalls?: number }
      ).__agentScrollIntoViewCalls)).toBe(0);
      await expect.poll(() => page.locator('.terminal-view').evaluate((el) => el.scrollTop)).toBe(0);
    });

    test('completion summary renders as a normal assistant reply, not a task note', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await page.locator('.tab-add').click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
      await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });
      await sendAgentPrompt(page, 'completion:final completion summary');

      const reply = page.locator('.agent-msg-reply:visible', { hasText: 'final completion summary' });
      await expect(reply).toBeVisible({ timeout: 5_000 });
      await expect(reply.locator('.agent-msg-label')).toHaveCount(0);
      await expect(page.locator('.agent-msg-note:visible', { hasText: 'final completion summary' })).toHaveCount(0);
    });

    test('Copilot stays streaming until its delayed completion reply is visible', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await page.locator('.tab-add').click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
      await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

      const scenario = 'delay:1500|completion:autopilot completion boundary';
      await sendAgentPrompt(page, scenario);

      await expect(page.locator('.agent-status-label:visible')).toHaveText('running', { timeout: 1_000 });
      await page.waitForTimeout(500);
      await expect(page.locator('.agent-status-label:visible')).toHaveText('running');
      await expect(page.locator('.agent-msg-reply:visible', { hasText: 'autopilot completion boundary' })).toHaveCount(0);

      const reply = page.locator('.agent-msg-reply:visible', { hasText: 'autopilot completion boundary' });
      await expect(reply).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });

      const rows = await page.locator('.agent-messages:visible > .agent-msg').allTextContents();
      expect(rows.findIndex((text) => text.includes(scenario)))
        .toBeLessThan(rows.findIndex((text) => text.includes('autopilot completion boundary') && !text.includes(scenario)));
    });

    test('late chunks upsert one persisted history row', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // Default save throttle is 5s: the base snapshot persists first, then the
      // same msgId receives a late append and must update that row on its next save.
      await sendAgentPrompt(page, 'late_append:6000:early-content:late-content');
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
      await expect(page.locator('.agent-msg-reply:visible', { hasText: 'early-content' })).toHaveCount(1);
      await page.waitForTimeout(12_000);
      await expect(page.locator('.agent-msg-reply:visible', { hasText: 'early-contentlate-content' })).toHaveCount(1);

      // Inspect the renderer-owned persistence boundary directly. A page reload
      // intentionally disconnects the ephemeral E2E project/tab, so it cannot
      // exercise hydration of this same session. The storage rows are the exact
      // write-side contract under regression here.
      const persisted = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('shelf-agent-history');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rows = await new Promise<any[]>((resolve, reject) => {
          const request = db.transaction('messages', 'readonly').objectStore('messages').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return rows.filter((row) => row.type === 'reply' && row.content.includes('early-content'));
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0].content).toBe('early-contentlate-content');
    });

    // Regression: providers piggyback mid-execution usage/quota on `state:'streaming'`
    // status events (copilot: rateLimits / contextUsage). The queued-cancel fix
    // (agent-core#10) must strip `state` only on the TERMINAL idle — dropping
    // streaming-status metrics wholesale blanks the status-bar quota.
    test('mid-execution streaming usage/quota reaches the status bar', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // `usage` emits a streaming status with contextUsage + rateLimits, then the
      // execution produces its reply. Segments are sticky, so they persist post-execution.
      await sendAgentPrompt(page, 'usage|text:done');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('done', { timeout: 5_000 });

      const statusBar = page.locator('.agent-status-bar:visible');
      await expect(statusBar).toContainText('ctx: 42%', { timeout: 5_000 });
      await expect(statusBar).toContainText('quota: 7%', { timeout: 5_000 });
    });

    test('/clear removes session context usage without clearing account quota', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'usage|text:done');

      const statusBar = page.locator('.agent-status-bar:visible');
      await expect(statusBar).toContainText('ctx: 42%', { timeout: 5_000 });
      await expect(statusBar).toContainText('quota: 7%', { timeout: 5_000 });

      await sendAgentPrompt(page, '/clear');
      await expect(page.locator('.agent-messages:visible')).toContainText('Fake context cleared.', { timeout: 5_000 });
      await expect(statusBar).not.toContainText('ctx: 42%');
      await expect(statusBar).toContainText('quota: 7%');
    });

    // Account-level credit (copilot premium requests) is fetched AFTER the execution
    // via backend.refreshAccountStatus and delivered executionId-less through the
    // session sink — not on the execution's status. Proves the full post-execution path
    // (fire-and-forget refresh → session-scoped status → status bar). agent-providers#26.
    test('post-execution account credit reaches the status bar', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'credit');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('credit armed', { timeout: 5_000 });

      const statusBar = page.locator('.agent-status-bar:visible');
      await expect(statusBar).toContainText('premium: 3/10 (30%)', { timeout: 5_000 });
    });

    // Regression: copilot ACP boundary-split makes one reply per tool boundary,
    // each a chunk-only segment that settles only at execution-end idle. The streaming
    // caret (`.agent-cursor`) must live on ONLY the live segment — earlier ones
    // must settle when the next starts, not blink until idle. See agent-providers#27.
    test('boundary-split: only the live segment shows a streaming caret', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // Two chunk-only segments split by a tool, then a trailing delay so the execution
      // is STILL streaming when we assert (the bug is a mid-execution state).
      await sendAgentPrompt(page, 'chunk:first-answer|tool:Read|chunk:second-answer|delay:2000');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('second-answer', { timeout: 5_000 });
      // Both segments are on screen and the execution is mid-stream → exactly ONE caret.
      await expect(page.locator('.agent-cursor:visible')).toHaveCount(1, { timeout: 2_000 });

      // After idle, no caret remains anywhere.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
      await expect(page.locator('.agent-cursor:visible')).toHaveCount(0, { timeout: 5_000 });
    });

    test('content arriving after idle stays settled and visible', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'late_chunk:300:late tail');

      // The query settles before the scheduled provider notification.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
      await expect(page.locator('.agent-messages:visible')).toContainText('late tail', { timeout: 5_000 });
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
      await expect(page.locator('.agent-cursor:visible')).toHaveCount(0);
    });
  });

  test.describe('fold (tool_use)', () => {
    test('message spacing settings save decimals without a maximum and cancel drafts', async ({ shelfApp: { page, userDataDir } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'subagent:spacing settings');
      const list = page.locator('.agent-messages:visible');
      const outer = list.locator(':scope > .agent-msg-fold').first();
      await expect(outer).toBeVisible();
      await outer.locator('.fold-header').first().click();
      const nested = list.locator('.agent-subagent-nested');
      await expect(nested).toBeVisible();
      await expect(list).toHaveCSS('row-gap', '2px');
      const openSettings = async () => {
        await page.keyboard.press(`${modifier}+,`);
        await page.getByRole('button', { name: 'Agent', exact: true }).click();
      };
      const input = page.getByLabel('Message spacing (px)');
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await openSettings();
      await expect(input).toHaveValue('2');
      await input.fill('3.5');
      await expect(list).toHaveCSS('row-gap', '2px');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await openSettings();
      await expect(input).toHaveValue('2');
      await input.fill('-1');
      await expect(save).toBeDisabled();
      await input.fill('');
      await expect(save).toBeDisabled();
      await input.fill('32.5');
      await expect(save).toBeEnabled();
      await save.click();
      await expect(list).toHaveCSS('row-gap', '32.5px');
      await expect(nested).toHaveCSS('row-gap', '32.5px');
      const persistedGap = () => JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8')).agentMessageGap;
      await expect.poll(persistedGap).toBe(32.5);
      await openSettings();
      await expect(input).toHaveValue('32.5');
      await input.fill('0');
      await save.click();
      await expect.poll(persistedGap).toBe(0);
      await expect(page.locator('.agent-messages:visible')).toHaveCSS('row-gap', '0px');
      await page.reload();
      await expect(page.locator('.app')).toBeVisible();
      await openSettings();
      await expect(input).toHaveValue('0');
    });

    test('message spacing comes only from the list gap with compact clickable headers', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'tool:Read|tool:Bash|text:spacing reply');
      const list = page.locator('.agent-messages:visible');
      const cards = list.locator(':scope > .agent-msg-fold');
      await expect(cards).toHaveCount(2);
      await expect(list).toContainText('spacing reply');
      const measure = () => list.evaluate((el) => {
        const rows = [...el.querySelectorAll(':scope > .agent-msg')];
        return rows.slice(1).map((row, index) => (
          row.getBoundingClientRect().top - rows[index].getBoundingClientRect().bottom
        ));
      });
      for (const gap of await measure()) expect(gap).toBeCloseTo(2, 1);
      // Changing just the container gap must fully control inter-message space.
      await list.evaluate((el) => { el.style.gap = '7px'; });
      for (const gap of await measure()) expect(gap).toBeCloseTo(7, 1);
      const header = cards.first().locator('.fold-header');
      const bounds = await header.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(20);
      expect(bounds!.height).toBeLessThanOrEqual(24);
      await header.click();
      await expect(cards.first().locator('.fold-body')).toBeVisible();
      await header.click();
      await expect(cards.first().locator('.fold-body')).toHaveCount(0);
    });

    test('tool: renders a fold card with the tool name and ok result', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'tool:Read');

      // Tool results render as fold cards. Body is hidden when collapsed
      // (fold_code defaults to collapsed), so match by header label instead.
      const toolCard = page.locator('.agent-msg-fold:has(.fold-label:has-text("Read")):visible').last();
      await expect(toolCard).toBeVisible({ timeout: 5_000 });
      await expect(toolCard.locator('.fold-label')).toHaveText('Read');
    });

    test('tool_err: shows error banner on failed fold card', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'tool_err:Bash');

      const toolCard = page.locator('.agent-msg-fold:has(.fold-error-banner):visible').last();
      await expect(toolCard).toBeVisible({ timeout: 5_000 });
      await expect(toolCard.locator('.fold-label')).toHaveText('Bash');
      // First failure opens the code card; its banner stays visible independently.
      await expect(toolCard.locator('.fold-error-banner')).toBeVisible();
    });
  });

  test('Clear History removes the rendered timeline and leaves the agent usable', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'text:before clear|tool:Read');

    const messages = page.locator('.agent-messages:visible');
    await expect(messages).toContainText('before clear', { timeout: 5_000 });
    await expect(messages.locator('.fold-label', { hasText: 'Read' })).toBeVisible();
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });

    await page.locator('.agent-reset-btn:visible', { hasText: 'Clear History' }).click();
    await expect(messages.locator('.agent-msg')).toHaveCount(0);
    await expect(messages.locator('.agent-empty')).toHaveText('Send a message to start');

    await sendAgentPrompt(page, 'text:after clear');
    await expect(messages).toContainText('after clear', { timeout: 5_000 });
    await expect(messages).not.toContainText('before clear');
  });

  test('auth_required swaps the view for the auth pane', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    // The entire agent view flips to the auth pane on auth_required.
    await expect(page.locator('.agent-auth-pane:visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.agent-auth-title:visible')).toHaveText('Fake Harness not authenticated');
    // OAuth pane renders the method's fallback hints under the login button
    // (Copilot uses this to point headless remotes at a token env var).
    await expect(page.locator('.agent-auth-hints:visible')).toBeVisible();
  });

  test('interactive login: URL gate → device code → cancel → back to button', async ({ shelfApp: { app, page } }) => {
    await app.evaluate(({ shell, clipboard }) => {
      const testGlobal = globalThis as typeof globalThis & { __copilotOpenedUrls?: string[] };
      testGlobal.__copilotOpenedUrls = [];
      clipboard.clear();
      shell.openExternal = async (url: string) => {
        testGlobal.__copilotOpenedUrls!.push(url);
      };
    });
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });

    // oauth method → interactive Login button (start_login round-trip). Copy is
    // provider-agnostic ("Log in") — GitHub is Copilot-specific and wrong for codex.
    const loginBtn = pane.locator('.agent-reset-btn', { hasText: 'Log in' });
    await expect(loginBtn).toBeVisible({ timeout: 5_000 });
    await loginBtn.click();

    const loginUrl = 'https://github.com/login/device?user_code=FAKE-CODE';
    const urlPopup = page.locator('.external-url-intent-overlay');
    await expect(urlPopup).toBeVisible({ timeout: 5_000 });
    await expect(urlPopup.locator('.external-url-intent-url')).toHaveText(loginUrl);
    await expect(urlPopup.locator('.external-url-intent-source')).toContainText(' / Claude');

    // The automatic provider prompt defaults to Copy URL; it does not launch a
    // browser before the user chooses.
    await page.keyboard.press('Enter');
    await expect(urlPopup).not.toBeVisible();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(loginUrl);
    expect(await app.evaluate(() => (
      (globalThis as typeof globalThis & { __copilotOpenedUrls?: string[] }).__copilotOpenedUrls
    ))).toEqual([]);

    // auth_login_prompt also flowed back → device code + manual link remain shown.
    await expect(pane.locator('.agent-auth-code')).toHaveText('FAKE-CODE', { timeout: 5_000 });
    await expect(pane.locator('.agent-auth-waiting')).toBeVisible();
    const authLink = pane.locator('a.agent-auth-link');
    await expect(authLink).toHaveAttribute('href', loginUrl);

    // Reopening the visible fallback link uses the same gate. Cancel performs no
    // action; a later explicit Open hands the exact URL to the default-app seam.
    await authLink.click();
    await expect(urlPopup).toBeVisible();
    await urlPopup.locator('.agent-perm-option', { hasText: 'Cancel' }).click();
    await expect(urlPopup).not.toBeVisible();

    await authLink.click();
    await expect(urlPopup).toBeVisible();
    await urlPopup.locator('.agent-perm-option', { hasText: 'Open with default app' }).click();
    await expect(urlPopup).not.toBeVisible();
    expect(await app.evaluate(() => (
      (globalThis as typeof globalThis & { __copilotOpenedUrls?: string[] }).__copilotOpenedUrls
    ))).toEqual([loginUrl]);

    // Cancel → cancel_login → auth_login_done{cancelled} → back to the button.
    await pane.locator('.agent-reset-btn', { hasText: 'Cancel' }).click();
    await expect(pane.locator('.agent-auth-code')).toHaveCount(0, { timeout: 5_000 });
    await expect(pane.locator('.agent-reset-btn', { hasText: 'Log in' })).toBeVisible();
  });

  test.describe('interactive login succeeds', () => {
    test.use({ loginSuccess: true });

    test('clears auth and init overlays and leaves the originating pane usable', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'auth_required');

      const pane = page.locator('.agent-auth-pane:visible');
      await expect(pane).toBeVisible({ timeout: 5_000 });
      await pane.locator('.agent-reset-btn', { hasText: 'Log in' }).click();

      await expect(page.locator('.agent-auth-pane:visible')).toHaveCount(0, { timeout: 5_000 });
      await expect(page.locator('.agent-conn-overlay')).toHaveCount(0, { timeout: 5_000 });
      const ta = page.locator('.agent-textarea:visible');
      await expect(ta).toBeEnabled();
      await ta.fill('/model');
      await ta.press('Enter');
      await expect(page.locator('.agent-permission:visible')).toContainText('fake-model-after-auth');
    });
  });

  test('manual auth Retry stays phase-silent and publishes fresh capabilities', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await pane.locator('.agent-reset-btn', { hasText: 'Retry' }).click();

    await expect(page.locator('.agent-auth-pane:visible')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('.agent-conn-overlay')).toHaveCount(0, { timeout: 5_000 });
    const ta = page.locator('.agent-textarea:visible');
    await expect(ta).toBeEnabled();
    await ta.fill('/model');
    await ta.press('Enter');
    await expect(page.locator('.agent-permission:visible')).toContainText('fake-model-after-auth');
  });

  test('sdk-managed auth Check again stays on the pane while credentials remain invalid', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required_sdk');

    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await expect(pane.locator('.agent-auth-title')).toHaveText('Fake Harness SDK not signed in');
    const checkAgain = pane.locator('.agent-reset-btn', { hasText: 'Check again' });
    await expect(checkAgain).toBeVisible();
    await checkAgain.click();

    await expect(pane).toBeVisible();
    await expect(pane.locator('.agent-auth-error')).toHaveText('Still no valid credentials found.');
  });

  test('sdk-managed auth Log in opens an interactive terminal on the same project', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required_sdk');

    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await expect(pane.locator('.agent-auth-instructions')).toContainText('Open a terminal');
    await pane.locator('.agent-reset-btn', { hasText: 'Log in' }).click();

    await expect(page.locator('.tab-bar .tab')).toHaveCount(3, { timeout: 5_000 });
    await expect(page.locator('.tab-bar .tab.active')).toContainText('Fake Harness Login');
    await expect.poll(() => readActiveTerminalText(page), { timeout: 12_000 })
      .toContain('fake auth login launched');
  });

  test('thinking: renders as a fold_text card', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'thinking:considering options');

    // Thinking maps to fold_text with label "Thinking". Body is collapsed by
    // default — match by header label, then click to expand and verify content.
    const card = page.locator('.agent-msg-fold:has(.fold-label:has-text("Thinking")):visible').last();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.locator('.fold-header').click();
    await expect(card.locator('.fold-body-text')).toContainText('considering options');
  });

  test('picker_number: integer-only input flow', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'picker_number');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // No option list — only the numeric input.
    await expect(panel.locator('.picker-option')).toHaveCount(0);
    // input[type=number] is the rendered control for integer inputType.
    const input = panel.locator('.picker-other-input');
    await expect(input).toHaveAttribute('type', 'number');

    await input.fill('42');
    await panel.locator('.picker-btn-primary').click();

    await expect(page.locator('.agent-messages:visible')).toContainText('picker_answers:["42"]', { timeout: 5_000 });
  });

  test('chain: scenarios run in order and produce all messages', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // Two text + one tool, separated by a tiny delay. All three should
    // appear and the execution should settle to idle.
    await sendAgentPrompt(page, 'text:hello|delay:30|tool:Read|text:bye');

    const messages = page.locator('.agent-messages:visible');
    await expect(messages).toContainText('hello', { timeout: 5_000 });
    await expect(messages).toContainText('bye');
    await expect(messages.locator('.fold-label', { hasText: 'Read' })).toBeVisible();
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
  });

  test('unknown prompt: fake-echo fallback renders as text', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // Anything that doesn't prefix-match a known scenario falls back to
    // an echo so dev-mode pokes still produce visible output.
    await sendAgentPrompt(page, 'totally unknown scenario');

    await expect(page.locator('.agent-messages:visible'))
      .toContainText('fake-echo: totally unknown scenario', { timeout: 5_000 });
  });

  test('error event renders as an error message', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'error:something broke');

    const err = page.locator('.agent-msg-error:visible').last();
    await expect(err).toBeVisible({ timeout: 5_000 });
    await expect(err).toContainText('something broke');
  });

  test('stop via double-Esc cancels mid-execution picker', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // delay:5000 keeps the execution open in case picker resolves fast on its own;
    // we hit Esc to abort once the panel is visible.
    await sendAgentPrompt(page, 'picker_single|delay:5000');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // First Esc dismisses the picker (cancelled payload echoed back).
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    // Then the execution is still running due to `delay:5000` — second Esc twice
    // hits the stop affordance ("Press Esc again to stop").
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Status returns to idle after stop().
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
  });

  test('Copilot double-Esc stops late work even after the prompt reports idle', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
    await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

    await sendAgentPrompt(page, 'late_chunk:1500:must-not-arrive');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.waitForTimeout(2_000);
    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'must-not-arrive' })).toHaveCount(0);
  });

  test('typing between Escape presses does not stop idle Copilot work', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
    await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

    await sendAgentPrompt(page, 'late_chunk:1500:copilot-still-running');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    const input = page.locator('.agent-textarea:visible');
    await input.focus();
    await page.keyboard.press('Escape');
    await input.pressSequentially('draft text');
    await page.keyboard.press('Escape');

    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'copilot-still-running' })).toBeVisible({ timeout: 3_000 });
    await expect(input).toHaveValue('draft text');
  });

  test('Codex double-Esc stops late work even after the turn reports idle', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Codex)' }).click();
    await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });

    await sendAgentPrompt(page, 'late_chunk:1500:codex-must-not-arrive');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.waitForTimeout(2_000);
    await expect(page.locator('.agent-msg-reply:visible', { hasText: 'codex-must-not-arrive' })).toHaveCount(0);
  });

  test.describe('queued messages', () => {
    // Remote queue removal is authoritative. Holding the real cancel IPC lets
    // us verify the renderer never discards the only copy while it is pending.
    test('retains the queued chip until remote cancellation is confirmed', async ({ shelfApp: { app, page } }) => {
      await setupProject(page); await openAgentTab(page);
      await app.evaluate(({ ipcMain }, channel) => {
        const original = (ipcMain as any)._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, payload) => new Promise(resolve => {
          (globalThis as any).__releaseQueueCancel = async () => resolve(await original(event, payload));
        }));
      }, IPC.AGENT_CANCEL_QUEUED);
      await sendAgentPrompt(page, 'delay:10000|text:holding work');
      await sendAgentPrompt(page, 'text:cancel only after confirmation');
      const queued = page.locator('.agent-msg-queued');
      await expect(queued).toHaveCount(1);
      await queued.locator('.agent-queued-cancel').click();
      await expect(queued).toContainText('cancelling');
      await expect(queued.locator('.agent-queued-cancel')).toBeDisabled();
      await expect(queued).toContainText('cancel only after confirmation');
      await app.evaluate(async () => (globalThis as any).__releaseQueueCancel());
      await expect(queued).toHaveCount(0);
      await expect(page.locator('.agent-msg-user:not(.agent-msg-queued)', { hasText: 'cancel only after confirmation' })).toHaveCount(0);
    });

    test('keeps one persisted user row when queued work starts before cancellation reaches the queue', async ({ shelfApp: { app, page } }) => {
      await setupProject(page); await openAgentTab(page);
      await app.evaluate(({ ipcMain }, channel) => {
        const original = (ipcMain as any)._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, payload) => new Promise(resolve => {
          (globalThis as any).__releaseQueueCancel = async () => {
            const result = await original(event, payload);
            (globalThis as any).__queueCancelResult = result;
            resolve(result);
          };
        }));
      }, IPC.AGENT_CANCEL_QUEUED);
      await sendAgentPrompt(page, 'delay:3000|text:first work finished');
      const content = 'text:race work started|delay:8000';
      await sendAgentPrompt(page, content);
      const queued = page.locator('.agent-msg-queued');
      await expect(queued).toHaveCount(1);
      await queued.locator('.agent-queued-cancel').click();
      await expect(queued).toContainText('cancelling');
      const row = page.locator('.agent-msg-user:not(.agent-msg-queued)', { hasText: content });
      await expect(row).toHaveCount(1, { timeout: 10000 });
      await app.evaluate(async () => (globalThis as any).__releaseQueueCancel());
      expect(await app.evaluate(() => (globalThis as any).__queueCancelResult)).toEqual({ status: 'running' });
      await expect(row).toHaveCount(1);
      await expect.poll(async () => (await storedAgentMessages(page)).filter(m => m.type === 'user' && m.content === content).length, { timeout: 15000 }).toBe(1);
    });

    test('shows cancellation failure without deleting the queued input and allows explicit retry', async ({ shelfApp: { app, page } }) => {
      await setupProject(page); await openAgentTab(page);
      await app.evaluate(({ ipcMain }, channel) => {
        const original = (ipcMain as any)._invokeHandlers.get(channel);
        let first = true;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, payload) => {
          if (first) { first = false; throw new Error('test cancellation connection failure'); }
          return original(event, payload);
        });
      }, IPC.AGENT_CANCEL_QUEUED);
      await sendAgentPrompt(page, 'delay:10000|text:holding work');
      await sendAgentPrompt(page, 'text:retain on cancellation error');
      const queued = page.locator('.agent-msg-queued');
      await expect(queued).toHaveCount(1);
      await queued.locator('.agent-queued-cancel').click();
      await expect(page.locator('.agent-messages:visible')).toContainText('Queue cancellation was not confirmed');
      await expect(queued).toContainText('retain on cancellation error');
      await expect(queued.locator('.agent-queued-cancel')).toBeEnabled();
      await queued.locator('.agent-queued-cancel').click();
      await expect(queued).toHaveCount(0);
    });

    // Messages submitted while a execution streams are EAGER-sent (each with a
    // clientMsgId) and queued by agent-server, which serializes them one execution at
    // a time and emits a queue snapshot the renderer mirrors as chips. This e2e
    // covers the WIRING a unit test can't: every queued send actually drains
    // through IPC → agent-server → provider and runs in order.
    // The reconcile + queue logic itself is unit-tested deterministically
    // (queue-reconcile.test.ts, send-queue.test.ts).
    //
    // We deliberately DON'T assert the transient `.agent-msg-queued` count
    // (2→1→0): that intermediate state is timing-sensitive and was flaky on slow
    // e2e hosts (e.g. WSL2) for no added coverage. Asserting the final outcome
    // (all three ran, queue drained) is robust.
    test('queued messages all flush through and run', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // T1 holds the execution open so T2/T3 are submitted while streaming → enqueued.
      await sendAgentPrompt(page, 'delay:1500|text:T1');
      await expect(page.locator('.agent-loading')).toBeVisible({ timeout: 5_000 });
      await sendAgentPrompt(page, 'delay:300|text:T2');
      await sendAgentPrompt(page, 'delay:300|text:T3');

      // All three executions flush through the queue and produce their output, and the
      // queue ends empty.
      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('T1', { timeout: 10_000 });
      await expect(messages).toContainText('T2', { timeout: 10_000 });
      await expect(messages).toContainText('T3', { timeout: 10_000 });
      await expect(page.locator('.agent-msg-queued')).toHaveCount(0, { timeout: 10_000 });
    });

    // Regression: cancelling a QUEUED send must not disturb the RUNNING execution's
    // status. agent-server emits a bare `idle` on the cancelled send's executionId
    // (to release its per-execution generator); that per-execution idle must NOT flip the
    // tab-wide streaming flag to idle while a foreground execution is still running
    // (session idle is owned by main's activeExecutions, emitted only when the LAST
    // execution ends). Before the fix, cancelling the chip cleared the spinner mid-run.
    test('cancelling a queued send leaves the running execution streaming', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // T1 holds the execution open (long delay, no text yet → spinner stays up).
      await sendAgentPrompt(page, 'delay:4000|text:T1');
      await expect(page.locator('.agent-loading')).toBeVisible({ timeout: 5_000 });

      // T2 is submitted while T1 streams → enqueued as a chip.
      await sendAgentPrompt(page, 'text:T2');
      const queued = page.locator('.agent-msg-queued');
      await expect(queued).toHaveCount(1, { timeout: 5_000 });

      // Cancel the queued chip. Its terminateExecution idle must not clear the spinner.
      await queued.locator('.agent-queued-cancel').click();
      await expect(queued).toHaveCount(0, { timeout: 5_000 });

      // The running execution (T1) is still going: spinner stays visible. Wait past the
      // cancel's IPC round-trip so the (previously bug-inducing) idle has arrived.
      await expect(page.locator('.agent-loading')).toBeVisible();
      await page.waitForTimeout(1000);
      await expect(page.locator('.agent-loading')).toBeVisible();

      // T1 still completes normally; T2 was cancelled and never runs.
      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('T1', { timeout: 10_000 });
      await expect(page.locator('.agent-loading')).toHaveCount(0, { timeout: 5_000 });
      await expect(messages).not.toContainText('T2');
    });
  });

  // Agent tabs are plain DOM (no xterm SearchAddon), so the SearchBar routes
  // through Chromium's native findInPage via IPC and shows a match counter.
  // Covers the wiring a unit test can't reach: SearchBar → window:find →
  // main forwarder → window:find-result → counter render.
  //
  // Harness note: NODE_ENV=test launches the window hidden (show:false), and a
  // hidden window doesn't emit 'found-in-page' for the fire-and-forget find the
  // keystroke issues. The find request still binds the main forwarder; we then
  // nudge Chromium to actually emit by showing the window inactively and
  // re-issuing the *same* find from main. Our bound forwarder relays that event
  // to the renderer exactly as it would in a real, visible window — so this
  // asserts our relay + counter, not Chromium's emission (which isn't our code).
  test.describe('in-page search', () => {
    const emit = (app: import('@playwright/test').ElectronApplication, text: string) =>
      app.evaluate(({ BrowserWindow }, t) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.showInactive();
        win.webContents.findInPage(t);
      }, text);

    test('finds conversation text and shows a match count', async ({ shelfApp: { app, page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // 'zumwaltberry' renders in the DOM (user echo bubble + agent reply).
      await sendAgentPrompt(page, 'text:zumwaltberry');
      await expect(page.locator('.agent-messages:visible')).toContainText('zumwaltberry', { timeout: 5_000 });

      // mod+f opens the find bar (default 'search' keybinding).
      await page.keyboard.press(`${modifier}+f`);
      const bar = page.locator('.search-bar');
      await expect(bar).toBeVisible({ timeout: 3_000 });

      // Type → routes through findInPage IPC (agent tab, no xterm addon) and
      // binds the main forwarder. Then nudge the emission.
      await bar.locator('.search-input').fill('zumwaltberry');
      await emit(app, 'zumwaltberry');
      // Counter shows "<active>/<total>" with a non-zero total — proves the full
      // relay: SearchBar → window:find → main forwarder → window:find-result →
      // counter render.
      await expect(page.locator('.search-count')).toHaveText(/^\d+\/[1-9]\d*$/, { timeout: 5_000 });

      // Close button hides the bar (× avoids depending on input focus, which
      // the find-nudge above moves).
      await bar.locator('.search-btn', { hasText: '×' }).click();
      await expect(bar).not.toBeVisible({ timeout: 3_000 });
    });
  });

  // /mcp and /skills are interactive-TUI-only in the real CLIs (not SDK-
  // dispatchable), so the provider intercepts them and prints a read-only
  // fold_markdown card from normalized data. The fake provider mirrors this with
  // canned data. Covers the slash → intercept → card wiring (the format itself
  // is unit-tested in loaded-context.test.ts).
  test.describe('loaded MCP / skills listings', () => {
    // Rendered as a plain agent reply (full-width markdown table), NOT a fold
    // card — so the result is a `<table>` directly in the timeline.
    test('/mcp prints a full-width table of MCP servers + status', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, '/mcp');
      const table = page.locator('.agent-messages:visible table').last();
      await expect(table).toBeVisible({ timeout: 5_000 });
      await expect(table).toContainText('fake-fs');
      await expect(table).toContainText('connected');
      await expect(table).toContainText('fake-db');
      await expect(table).toContainText('down'); // failed server's error
      // Not wrapped in a fold/tool card.
      await expect(page.locator('.agent-msg-fold:has(.fold-label:has-text("/mcp"))')).toHaveCount(0);
    });

    test('/skills prints a full-width table of skills + source', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, '/skills');
      const table = page.locator('.agent-messages:visible table').last();
      await expect(table).toBeVisible({ timeout: 5_000 });
      await expect(table).toContainText('fake-skill');
      await expect(table).toContainText('app'); // normalized source tag
    });
  });

  // Long slash lists (e.g. ACP's 32 commands) overflow the menu's max-height
  // scroll. The dropdown must render ALL matches (not a hard cap) and keep the
  // keyboard-selected row scrolled into view. See SlashMenu.
  test('slash menu renders all commands and scrolls the selection into view', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    const ta = page.locator('.agent-textarea:visible');
    await ta.click();
    await ta.type('/');

    const menu = page.locator('.agent-slash-menu:visible');
    await expect(menu).toBeVisible();
    const items = menu.locator('.agent-slash-item');
    const count = await items.count();
    // Regression: the old `.slice(0, 10)` capped rendering — a long list must
    // render every entry so the tail is reachable at all.
    expect(count).toBeGreaterThan(10);

    // Arrow to the LAST entry — past the visible fold. (Order is provider list +
    // renderer-local commands, so don't assume which name is last — assert by
    // position instead.)
    for (let i = 0; i < count - 1; i++) await ta.press('ArrowDown');
    await expect(items.last()).toHaveClass(/agent-slash-item-selected/);
    // Regression: without scroll-into-view the menu stays at scrollTop 0 and the
    // selected tail row is clipped out of the scroll viewport.
    const scrollTop = await menu.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
  });
});

test.describe('custom skill commands', () => {
  test.use({ homeProjectDirectories: false });

  test('app skill command: registered menu entry executes the bound skill with original message', async ({ shelfApp: { page, userDataDir } }) => {
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-view .notes-new-btn').click();
    await expect(page.locator('.skills-view .notes-textarea')).toHaveValue(/name: my-skill/);
    await page.getByLabel('Add to slash command menu').check();
    await page.getByRole('textbox', { name: 'Command', exact: true }).fill('dev-flow');
    await page.getByRole('textbox', { name: 'Command description', exact: true }).fill('Run fixture flow');
    await page.locator('.skills-view .notes-back').click();
    await expect(page.locator('.skills-list-command')).toHaveText('/dev-flow');
    await page.locator('.skills-view .notes-close').click();
    await setupProject(page); await openAgentTab(page);
    const input = page.locator('.agent-textarea:visible');
    await expect(input).toBeEnabled();
    await input.fill('/dev-');
    const command = page.locator('.agent-slash-item', { hasText: '/dev-flow' });
    await expect(command).toBeVisible();
    await expect(command).toHaveAttribute('aria-disabled', 'false');
    await command.click();
    await input.fill('/dev-flow task');
    await input.press('Enter');
    await expect(page.locator('.agent-view')).toContainText('App skill my-skill: task');
    await expect(page.locator('.agent-view')).toContainText('/dev-flow task');
    await input.evaluate(target => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'command-shot.png', { type: 'image/png' }));
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.agent-attachment-chip')).toHaveCount(1);
    await input.fill('/dev-flow'); await input.press('Enter');
    await expect(page.locator('.agent-messages:visible')).toContainText('Attachments: 1');
    await expect.poll(async () => (await storedAgentMessages(page)).find(row => row.type === 'user' && row.content === '/dev-flow')?.inputMessage?.attachments, { timeout: 15_000 }).toEqual([
      expect.objectContaining({ kind: 'image', name: 'command-shot.png' }),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'skills', 'skills', 'my-skill', '.shelf-command.json'), 'utf8')).alias).toBe('dev-flow');
  });

  test('app skill command: a stale menu choice is rejected and the original input is retained', async ({ shelfApp: { page } }) => {
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-view .notes-new-btn').click();
    await expect(page.locator('.skills-view .notes-textarea')).toHaveValue(/name: my-skill/);
    await page.getByLabel('Add to slash command menu').check();
    await page.getByRole('textbox', { name: 'Command', exact: true }).fill('dev-flow');
    await page.getByRole('textbox', { name: 'Command description', exact: true }).fill('Run fixture flow');
    await page.locator('.skills-view .notes-back').click();
    await expect(page.locator('.skills-list-command')).toHaveText('/dev-flow');
    await page.locator('.skills-view .notes-close').click();
    await setupProject(page); await openAgentTab(page);
    const input = page.locator('.agent-textarea:visible');
    await expect(input).toBeEnabled(); await input.fill('/dev-');
    await page.locator('.agent-slash-item', { hasText: '/dev-flow' }).click();
    await input.fill('/dev-flow retained task');
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-list-item').click();
    await page.getByLabel('Add to slash command menu').uncheck();
    await page.locator('.skills-view .notes-back').click();
    await expect(page.locator('.skills-list-command')).toHaveCount(0);
    await page.locator('.skills-view .notes-close').click();
    await input.press('Enter');
    await expect(page.locator('.agent-view')).toContainText('stale_selection');
    await expect(page.locator('.agent-view')).toContainText('/dev-flow retained task');
    await expect(page.locator('.agent-view')).not.toContainText('App skill my-skill: retained task');
  });

  async function registerCommand(page: Page, alias: string) {
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-view .notes-new-btn').click();
    await expect(page.locator('.skills-view .notes-textarea')).toHaveValue(/name: my-skill/);
    await page.getByLabel('Add to slash command menu').check();
    await page.getByRole('textbox', { name: 'Command', exact: true }).fill(alias);
    await page.getByRole('textbox', { name: 'Command description', exact: true }).fill('Run fixture flow');
    await page.locator('.skills-view .notes-back').click();
    await expect(page.locator('.skills-list-command')).toHaveText(`/${alias}`);
    await page.locator('.skills-view .notes-close').click();
  }

  test('app skill command: disabled entries cannot be selected and become ready after enabling', async ({ shelfApp: { page } }) => {
    await registerCommand(page, 'dev-flow');
    await setupProject(page); await openAgentTab(page);
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-enable-toggle').click();
    await expect(page.locator('.skills-list-item.disabled')).toBeVisible();
    await page.locator('.skills-view .notes-close').click();
    const input = page.locator('.agent-textarea:visible');
    await input.fill('/dev-');
    const command = page.locator('.agent-slash-item', { hasText: '/dev-flow' });
    await expect(command).toHaveAttribute('aria-disabled', 'true');
    await expect(command).toContainText('Skill is disabled');
    await command.click();
    await expect(input).toHaveValue('/dev-');
    await input.fill('');
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-enable-toggle').click();
    await expect(page.locator('.skills-list-item.disabled')).toHaveCount(0);
    await page.locator('.skills-view .notes-close').click();
    await input.fill('/dev-');
    await expect(command).toHaveAttribute('aria-disabled', 'false');
    await command.click(); await input.fill('/dev-flow enabled'); await input.press('Enter');
    await expect(page.locator('.agent-messages:visible')).toContainText('App skill my-skill: enabled');
  });

  test('app skill command: native collisions retain both menu rows and dispatch the native command', async ({ shelfApp: { page } }) => {
    await registerCommand(page, 'alpha');
    await setupProject(page); await openAgentTab(page);
    const input = page.locator('.agent-textarea:visible');
    await input.fill('/alp');
    const commands = page.locator('.agent-slash-item', { hasText: '/alpha' });
    await expect(commands).toHaveCount(2);
    await expect(commands.nth(1)).toHaveAttribute('aria-disabled', 'true');
    await expect(commands.nth(1)).toContainText('A native command owns this name');
    await commands.first().click(); await input.fill('/alpha native'); await input.press('Enter');
    await expect(page.locator('.agent-messages:visible')).toContainText('fake-echo: /alpha native');
    await expect(page.locator('.agent-messages:visible')).not.toContainText('App skill my-skill:');
  });

  test('app skill command: queued skill disabled before execution fails and the following input still runs', async ({ shelfApp: { page } }) => {
    await registerCommand(page, 'dev-flow');
    await setupProject(page); await openAgentTab(page);
    await sendAgentPrompt(page, 'delay:5000|text:blocker-finished');
    await expect(page.locator('.agent-loading')).toBeVisible();
    await sendAgentPrompt(page, '/dev-flow queued');
    await expect(page.locator('.agent-msg-queued')).toHaveCount(1);
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-enable-toggle').click();
    await expect(page.locator('.skills-list-item.disabled')).toBeVisible();
    await page.locator('.skills-view .notes-close').click();
    await sendAgentPrompt(page, 'text:after-rejection');
    const messages = page.locator('.agent-messages:visible');
    await expect(messages).toContainText('target_disabled', { timeout: 15000 });
    await expect(messages).toContainText('after-rejection', { timeout: 15000 });
    await expect(messages).not.toContainText('App skill my-skill: queued');
    await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
  });


  test('app skill command: Copilot accepts text commands and rejects command attachments without blocking image chat', async ({ shelfApp: { page } }) => {
    await registerCommand(page, 'dev-flow');
    await setupProject(page);
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
    const input = page.locator('.agent-textarea:visible');
    await expect(input).toBeEnabled();
    await input.fill('/dev-');
    const command = page.locator('.agent-slash-item', { hasText: '/dev-flow' });
    await expect(command).toHaveAttribute('aria-disabled', 'false');
    await command.click(); await input.fill('/dev-flow text'); await input.press('Enter');
    await expect(page.locator('.agent-messages:visible')).toContainText('App skill my-skill: text');
    const pasteImage = async () => {
      await input.evaluate(target => {
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'command-shot.png', { type: 'image/png' }));
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      });
      await expect(page.locator('.agent-attachment-chip')).toHaveCount(1);
    };
    await pasteImage(); await input.fill('/dev-flow image'); await input.press('Enter');
    const messages = page.locator('.agent-messages:visible');
    await expect(messages).toContainText('unsupported_attachments');
    await expect(messages).not.toContainText('App skill my-skill: image');
    // History writes are batched for 5s; allow the same window as other persistence cases.
    await expect.poll(async () => (await storedAgentMessages(page)).find(row => row.type === 'user' && row.content === '/dev-flow image')?.inputMessage?.attachments, { timeout: 15_000 }).toEqual([expect.objectContaining({ kind: 'image', name: 'command-shot.png' })]);
    await pasteImage(); await input.fill('text:ordinary-image-still-works'); await input.press('Enter');
    await expect(messages).toContainText('ordinary-image-still-works');
    await expect.poll(async () => (await storedAgentMessages(page)).find(row => row.type === 'user' && row.content === 'text:ordinary-image-still-works')?.inputMessage?.attachments, { timeout: 15_000 }).toEqual([expect.objectContaining({ kind: 'image', name: 'command-shot.png' })]);
    await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
  });

});
