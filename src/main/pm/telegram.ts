import { net } from 'electron';
import { log } from '@shared/logger';
import type { TelegramConfig } from '@shared/types';
import { isAwayMode } from './away-mode';

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT = 30; // seconds (Telegram long poll)
const MAX_MESSAGE_LENGTH = 4096;

let config: TelegramConfig | null = null;
let polling = false;
let pollAbort: AbortController | null = null;
let offset = 0;

type MessageCallback = (text: string, chatId: string) => void;
let onMessage: MessageCallback | null = null;

export function setMessageCallback(cb: MessageCallback): void {
  onMessage = cb;
}

export function startTelegram(cfg: TelegramConfig): void {
  if (polling) stopTelegram();
  config = cfg;
  if (!config.botToken || !config.chatId) return;
  polling = true;
  pollLoop();
  log.info('telegram', 'started polling');
}

export function stopTelegram(): void {
  polling = false;
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
  log.info('telegram', 'stopped polling');
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
  await sendMessage(msg);
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
          const msg = update.message;
          if (!msg?.text) continue;
          const chatId = String(msg.chat.id);
          if (chatId !== config.chatId) {
            log.debug('telegram', `ignored message from chat ${chatId}`);
            continue;
          }
          if (onMessage) onMessage(msg.text, chatId);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') continue;
      log.error('telegram', `poll error: ${err.message}`);
      // Back off on error
      if (polling) await sleep(5000);
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
    throw new Error(`Telegram API ${method} failed ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  return json.result;
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
