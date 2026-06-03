import os from 'os';
import { net } from 'electron';
import { log } from '@shared/logger';
import type { TabInferredState, TelegramConfig } from '@shared/types';
import { isAwayMode, setAwayMode as setAwayModeState } from './away-mode';
import { snapshotTabs } from './tab-watcher';

export type ListenerStopReason = 'bad-token' | 'bad-chat-id' | 'taken-over';

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT = 30; // seconds (Telegram long poll)
const MAX_MESSAGE_LENGTH = 4096;

const COMMANDS: { command: string; description: string }[] = [
  { command: 'help', description: 'List available commands' },
  { command: 'away', description: 'Toggle Away Mode' },
  { command: 'status', description: 'Show project / tab states' },
  { command: 'tabs', description: 'Alias for /status' },
  { command: 'stop', description: 'Cancel current PM generation' },
];

let config: TelegramConfig | null = null;
let polling = false;
let pollAbort: AbortController | null = null;
let offset = 0;

type MessageCallback = (text: string, chatId: string) => void;
type CallbackQueryHandler = (action: string, payload: string) => void;
type StopCallback = () => void;
let onMessage: MessageCallback | null = null;
let onCallbackQuery: CallbackQueryHandler | null = null;
let onStop: StopCallback | null = null;

// Fires when the listener stops itself on a fatal/conflict error (bad token,
// bad chat id, or another instance grabbing the bot). The wiring layer turns
// PM Active off + notifies the user. NOT fired on user-initiated stopTelegram().
type ListenerStoppedCallback = (reason: ListenerStopReason) => void;
let onListenerStopped: ListenerStoppedCallback | null = null;
let getProjectsFn: (() => { name: string; connectionType: string }[]) | null = null;

export function setListenerStoppedCallback(cb: ListenerStoppedCallback): void {
  onListenerStopped = cb;
}

export function setProjectsProvider(fn: () => { name: string; connectionType: string }[]): void {
  getProjectsFn = fn;
}

export function setMessageCallback(cb: MessageCallback): void {
  onMessage = cb;
}

export function setCallbackQueryHandler(cb: CallbackQueryHandler): void {
  onCallbackQuery = cb;
}

export function setStopCallback(cb: StopCallback): void {
  onStop = cb;
}

export function startTelegram(cfg: TelegramConfig): void {
  if (polling) stopTelegram();
  config = cfg;
  if (!config.botToken || !config.chatId) return;
  polling = true;
  // E2E: no real network — mark running so PM Active flows can be exercised
  // (enabling PM Active, Away dependency) without hitting api.telegram.org.
  if (process.env.SHELF_TEST_MODE === '1') {
    log.info('telegram', 'test mode — listener no-op (no network)');
    return;
  }
  // Validating first send — announces which host grabbed control AND validates
  // the config: bad token → 401, bad chat id → 400, either stops + notifies.
  // (getUpdates only validates the token; the announcement covers chat id.)
  sendControlAnnouncement().catch((err: any) => {
    const status = err?.status as number | undefined;
    if (status === 401 || status === 404) { stopOnError('bad-token'); return; }
    if (status === 400) { stopOnError('bad-chat-id'); return; }
    log.error('telegram', `announcement send failed: ${err?.message}`); // transient — pollLoop continues
  });
  registerCommands().catch((e) => log.error('telegram', `setMyCommands failed: ${e.message}`));
  pollLoop();
  log.info('telegram', 'started polling');
}

async function registerCommands(): Promise<void> {
  await apiCall('setMyCommands', { commands: COMMANDS });
  log.debug('telegram', `registered ${COMMANDS.length} commands`);
}

export function stopTelegram(): void {
  polling = false;
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
  log.info('telegram', 'stopped polling');
}

// Internal: stop the listener due to a fatal/conflict error and notify the
// wiring layer (→ PM Active off). Distinct from user-initiated stopTelegram().
function stopOnError(reason: ListenerStopReason): void {
  if (!polling) return;
  polling = false;
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
  log.info('telegram', `listener stopped: ${reason}`);
  onListenerStopped?.(reason);
}

async function sendControlAnnouncement(): Promise<void> {
  if (!config) return;
  const projects = getProjectsFn?.() ?? [];
  const lines = [`🖥 Now controlled by *${os.hostname()}*`, ''];
  if (projects.length === 0) {
    lines.push('_No projects._');
  } else {
    lines.push('*Projects:*');
    for (const p of projects) lines.push(`  • ${p.name} (${p.connectionType})`);
  }
  await apiCall('sendMessage', {
    chat_id: config.chatId,
    text: lines.join('\n'),
    parse_mode: 'Markdown',
  });
}

export function isRunning(): boolean {
  return polling;
}

export async function sendMessage(text: string): Promise<void> {
  if (!config) return;

  // Split long messages
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await apiCall('sendMessage', {
      chat_id: config.chatId,
      text: chunk,
      parse_mode: 'Markdown',
    });
  }
}

export async function sendPmResponse(text: string): Promise<void> {
  if (!config) return;
  const modeTag = isAwayMode() ? '`[away]`' : '`[watching]`';
  await sendMessage(`${modeTag}\n\n${text}`);
}

export async function sendEscalation(
  tabId: string,
  projectName: string,
  tabName: string,
  reason: string,
  snippet: string,
): Promise<void> {
  if (!config) return;
  const msg = [
    `⚠️ *Permission needed*`,
    `Project: ${projectName} — Tab: ${tabName}`,
    '',
    '```',
    snippet.slice(0, 500),
    '```',
    '',
    `PM note: ${reason}`,
  ].join('\n');
  await apiCall('sendMessage', {
    chat_id: config.chatId,
    text: msg,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Allow', callback_data: `escalation:allow:${tabId}` },
        { text: '❌ Deny', callback_data: `escalation:deny:${tabId}` },
      ]],
    },
  });
}

export async function sendAwayModePrompt(): Promise<void> {
  if (!config) return;
  const current = isAwayMode();
  const msg = current
    ? '🔴 Away Mode is *ON* — PM is controlling terminals.\nSwitch OFF to take back control?'
    : '🟢 Away Mode is *OFF* — you have control.\nSwitch ON to let PM manage terminals?';
  await apiCall('sendMessage', {
    chat_id: config.chatId,
    text: msg,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        current
          ? { text: '🟢 Switch OFF', callback_data: 'away:off' }
          : { text: '🔴 Switch ON', callback_data: 'away:on' },
      ]],
    },
  });
}

// ── Internal ──

async function pollLoop(): Promise<void> {
  while (polling && config) {
    try {
      pollAbort = new AbortController();
      const updates = await apiCall('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
      }, pollAbort.signal);

      if (!polling) break;

      if (Array.isArray(updates)) {
        for (const update of updates) {
          offset = update.update_id + 1;

          // Handle text messages
          const msg = update.message;
          if (msg?.text) {
            const chatId = String(msg.chat.id);
            if (chatId !== config.chatId) {
              log.debug('telegram', `ignored message from chat ${chatId}`);
              continue;
            }
            const cmd = msg.text.split(/\s+/)[0];
            if (cmd === '/away') {
              sendAwayModePrompt().catch((e) => log.error('telegram', `away prompt failed: ${e.message}`));
              continue;
            }
            if (cmd === '/help') {
              sendHelp().catch((e) => log.error('telegram', `help failed: ${e.message}`));
              continue;
            }
            if (cmd === '/status' || cmd === '/tabs') {
              sendStatus().catch((e) => log.error('telegram', `status failed: ${e.message}`));
              continue;
            }
            if (cmd === '/stop') {
              handleStop().catch((e) => log.error('telegram', `stop failed: ${e.message}`));
              continue;
            }
            if (onMessage) onMessage(msg.text, chatId);
          }

          // Handle callback queries (inline button presses)
          const cbq = update.callback_query;
          if (cbq) {
            const chatId = String(cbq.message?.chat?.id);
            if (chatId !== config.chatId) continue;
            await handleCallbackQuery(cbq);
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') continue;
      const status = err?.status as number | undefined;
      // 409 Conflict = another instance started polling the same bot and won
      // (newest poller wins). Yield immediately, NO retry — retrying would kick
      // the winner back and ping-pong forever. The user re-grabs by re-enabling.
      if (status === 409) {
        log.info('telegram', 'conflict (409) — another instance took over, yielding');
        stopOnError('taken-over');
        break;
      }
      // Bad bot token — won't fix itself, stop + report.
      if (status === 401 || status === 404) {
        log.error('telegram', `auth error ${status} — bad bot token, stopping`);
        stopOnError('bad-token');
        break;
      }
      // Transient (429 / 5xx / network / timeout) — back off and retry.
      log.error('telegram', `poll error: ${err.message}`);
      if (polling) await sleep(5000);
    }
  }
}

async function handleCallbackQuery(cbq: any): Promise<void> {
  const data = cbq.data as string;
  const messageId = cbq.message?.message_id;
  const now = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

  // Answer the callback to dismiss the loading spinner
  await apiCall('answerCallbackQuery', { callback_query_id: cbq.id });

  if (data.startsWith('escalation:')) {
    const [, action, tabId] = data.split(':');
    // Edit original message to show ack
    const ack = action === 'allow' ? `✅ Allowed by you at ${now}` : `❌ Denied by you at ${now}`;
    if (messageId) {
      await apiCall('editMessageReplyMarkup', {
        chat_id: config!.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
      await apiCall('editMessageText', {
        chat_id: config!.chatId,
        message_id: messageId,
        text: `${cbq.message?.text ?? ''}\n\n${ack}`,
        parse_mode: 'Markdown',
      }).catch(() => {});
    }
    if (onCallbackQuery) onCallbackQuery(action, tabId);
  } else if (data.startsWith('away:')) {
    const on = data === 'away:on';
    setAwayModeState(on);
    const ack = on ? `🔴 Away Mode switched ON at ${now}` : `🟢 Away Mode switched OFF at ${now}`;
    if (messageId) {
      await apiCall('editMessageReplyMarkup', {
        chat_id: config!.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
      await apiCall('editMessageText', {
        chat_id: config!.chatId,
        message_id: messageId,
        text: ack,
      }).catch(() => {});
    }
  }
}

async function apiCall(method: string, params: Record<string, any>, signal?: AbortSignal): Promise<any> {
  if (!config) return null;
  const url = `${API}${config.botToken}/${method}`;
  const resp = await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err: any = new Error(`Telegram API ${method} failed ${resp.status}: ${text}`);
    err.status = resp.status;
    throw err;
  }
  const json = await resp.json();
  return json.result;
}

async function sendHelp(): Promise<void> {
  const lines = ['*Available commands*', ''];
  for (const c of COMMANDS) {
    lines.push(`/${c.command} — ${c.description}`);
  }
  await sendMessage(lines.join('\n'));
}

async function sendStatus(): Promise<void> {
  const snapshot = snapshotTabs();
  if (snapshot.length === 0) {
    await sendMessage('_No tabs are open._');
    return;
  }
  const byProject = new Map<string, typeof snapshot>();
  for (const s of snapshot) {
    const list = byProject.get(s.projectName) ?? [];
    list.push(s);
    byProject.set(s.projectName, list);
  }
  const lines: string[] = ['*Status*', ''];
  for (const [proj, tabs] of byProject) {
    lines.push(`*${proj}*`);
    for (const t of tabs) {
      lines.push(`  ${stateIcon(t.state)} ${t.tabName} — ${stateLabel(t.state)}`);
    }
    lines.push('');
  }
  await sendMessage(lines.join('\n').trim());
}

async function handleStop(): Promise<void> {
  if (!onStop) {
    await sendMessage('_Stop handler not wired up._');
    return;
  }
  onStop();
  await sendMessage('🛑 Cancelled current PM generation.');
}

function stateIcon(s: TabInferredState): string {
  switch (s) {
    case 'idle_shell': return '○';
    case 'cli_running': return '●';
    case 'cli_waiting_input': return '⏳';
    case 'cli_waiting_permission': return '⚠️';
    case 'cli_error': return '❌';
    case 'cli_done': return '✅';
  }
}

function stateLabel(s: TabInferredState): string {
  switch (s) {
    case 'idle_shell': return 'idle';
    case 'cli_running': return 'running';
    case 'cli_waiting_input': return 'waiting input';
    case 'cli_waiting_permission': return 'waiting permission';
    case 'cli_error': return 'error';
    case 'cli_done': return 'done';
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (cut < MAX_MESSAGE_LENGTH / 2) cut = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
