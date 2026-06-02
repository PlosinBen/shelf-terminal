import { net } from 'electron';
import { log } from '@shared/logger';
import type { TabInferredState, TelegramConfig } from '@shared/types';
import { isAwayMode, setAwayMode as setAwayModeState } from './away-mode';
import { snapshotTabs } from './tab-watcher';
import { setSyncCallback } from './tools';
import {
  sendFromInternal,
  registerOutputObserver,
  stopFromInternal,
  isAgentTab,
} from '../agent';
import type { AgentEvent } from '../agent/types';
import {
  resolveAlias,
  buildUseCommands,
  formatProjectsList,
} from './telegram-mode';

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT = 30; // seconds (Telegram long poll)
const MAX_MESSAGE_LENGTH = 4096;

// Mode 切換 + agent-view bridge — see features/telegram-agent-bridge.md.
type Mode =
  | { type: 'pm' }
  | { type: 'agent'; tabId: string; projectName: string; provider: string };
let mode: Mode = { type: 'pm' };

// Active output observer for current agent mode. Null in PM mode.
let agentObserverUnsubscribe: (() => void) | null = null;

// Per-agent-turn reply accumulator. `reply` AgentMessage content is appended
// while `streaming`; flushed to Telegram on the next `idle` status event.
// Reset at the start of each turn so old text doesn't leak into a new one.
const agentReplyBuffer: string[] = [];
let agentTurnInProgress = false;

const BASE_COMMANDS: { command: string; description: string }[] = [
  { command: 'help', description: 'List available commands' },
  { command: 'pm', description: 'Switch to PM mode' },
  { command: 'projects', description: 'List projects' },
  { command: 'mode', description: 'Show current mode' },
  { command: 'away', description: 'Toggle Away Mode' },
  { command: 'status', description: 'Show project / tab states' },
  { command: 'tabs', description: 'Alias for /status' },
  { command: 'stop', description: 'Cancel current generation' },
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
  registerCommands().catch((e) => log.error('telegram', `setMyCommands failed: ${e.message}`));
  // Project list changes (add/rename/remove/agent-tab-open) → re-register
  // dynamic /use_<alias> commands so Telegram autocomplete reflects current
  // state. Debounced inside scheduleCommandRefresh.
  setSyncCallback(scheduleCommandRefresh);
  pollLoop();
  log.info('telegram', 'started polling');
}

let refreshCommandsTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCommandRefresh(): void {
  if (!polling) return;
  if (refreshCommandsTimer) return;
  refreshCommandsTimer = setTimeout(() => {
    refreshCommandsTimer = null;
    registerCommands().catch((e) => log.error('telegram', `setMyCommands refresh failed: ${e.message}`));
  }, 500);
}

async function registerCommands(): Promise<void> {
  // BASE_COMMANDS are always available. Dynamic /use_<alias> commands derive
  // from currently-open agent tabs (see telegram-mode.buildUseCommands).
  // Telegram caps setMyCommands at ~100 entries — well below normal usage.
  const dynamic = buildUseCommands();
  const all = [...BASE_COMMANDS, ...dynamic];
  await apiCall('setMyCommands', { commands: all });
  log.debug('telegram', `registered ${all.length} commands (${dynamic.length} dynamic /use_*)`);
}

export function stopTelegram(): void {
  polling = false;
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
  setSyncCallback(null);
  if (refreshCommandsTimer) {
    clearTimeout(refreshCommandsTimer);
    refreshCommandsTimer = null;
  }
  // Force any active agent observer to detach so we don't pump events into
  // a stopped bridge.
  if (agentObserverUnsubscribe) {
    agentObserverUnsubscribe();
    agentObserverUnsubscribe = null;
  }
  mode = { type: 'pm' };
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
            handleIncomingMessage(msg.text, chatId);
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
      log.error('telegram', `poll error: ${err.message}`);
      // Back off on error
      if (polling) await sleep(5000);
    }
  }
}

/**
 * Routes one incoming Telegram message to the right handler. Slash commands
 * are dispatched here; non-slash text goes to current mode (PM or agent).
 * See features/telegram-agent-bridge.md mode state machine.
 */
function handleIncomingMessage(text: string, chatId: string): void {
  const cmd = text.split(/\s+/)[0];

  // Mode-switch commands (always available, both modes).
  if (cmd === '/pm') {
    switchToPmMode().catch((e) => log.error('telegram', `pm switch failed: ${e.message}`));
    return;
  }
  if (cmd === '/projects') {
    sendMessage(formatProjectsList()).catch((e) => log.error('telegram', `projects failed: ${e.message}`));
    return;
  }
  if (cmd === '/mode') {
    sendModeStatus().catch((e) => log.error('telegram', `mode failed: ${e.message}`));
    return;
  }
  if (cmd.startsWith('/use_')) {
    const alias = cmd.slice('/use_'.length);
    switchToAgentMode(alias).catch((e) => log.error('telegram', `use_${alias} failed: ${e.message}`));
    return;
  }

  // Always-available bridge commands.
  if (cmd === '/help') {
    sendHelp().catch((e) => log.error('telegram', `help failed: ${e.message}`));
    return;
  }
  if (cmd === '/stop') {
    handleStop().catch((e) => log.error('telegram', `stop failed: ${e.message}`));
    return;
  }

  // PM-mode-only commands (silent no-op in agent mode — user must /pm first).
  if (mode.type === 'pm') {
    if (cmd === '/away') {
      sendAwayModePrompt().catch((e) => log.error('telegram', `away prompt failed: ${e.message}`));
      return;
    }
    if (cmd === '/status' || cmd === '/tabs') {
      sendStatus().catch((e) => log.error('telegram', `status failed: ${e.message}`));
      return;
    }
    // Non-command text → PM agent loop.
    if (onMessage) onMessage(text, chatId);
    return;
  }

  // Agent mode: non-mode-switch text (including unrecognised slashes) goes
  // to the agent as a query. Provider's parseSlashPrefix may interpret
  // /clear /compact /context etc — MVP doesn't special-case.
  routeMessageToAgent(text).catch((e) => log.error('telegram', `agent send failed: ${e.message}`));
}

async function switchToPmMode(): Promise<void> {
  if (agentObserverUnsubscribe) {
    agentObserverUnsubscribe();
    agentObserverUnsubscribe = null;
  }
  // Don't drop in-flight agent reply buffer — let it flush if turn completes
  // after switch. But mode is already 'pm' so the flush goes nowhere meaningful;
  // safe to clear.
  agentReplyBuffer.length = 0;
  agentTurnInProgress = false;
  mode = { type: 'pm' };
  await sendMessage('Back to PM mode.');
}

async function switchToAgentMode(alias: string): Promise<void> {
  const res = resolveAlias(alias);
  if (!res.ok) {
    const msg = {
      not_found: `_Alias \`${alias}\` not found. Try /projects to see available aliases._`,
      no_agent: `_Project found but has no active agent tab. Open one in Shelf first._`,
      multiple_agents: `_Multiple agent tabs in this project. Open Shelf to pick one._`,
    }[res.reason];
    await sendMessage(msg);
    return;
  }

  // Tear down previous observer if we were already in agent mode.
  if (agentObserverUnsubscribe) {
    agentObserverUnsubscribe();
    agentObserverUnsubscribe = null;
  }
  agentReplyBuffer.length = 0;
  agentTurnInProgress = false;

  mode = {
    type: 'agent',
    tabId: res.tabId,
    projectName: res.projectName,
    provider: res.provider,
  };

  // Subscribe to this tab's agent events for the duration of agent mode.
  agentObserverUnsubscribe = registerOutputObserver(res.tabId, handleAgentEvent);

  await sendMessage(`Switched to \`${res.projectName}/${res.provider}\`. Send a message to talk to the agent. /pm to switch back.`);
}

async function sendModeStatus(): Promise<void> {
  if (mode.type === 'pm') {
    await sendMessage('Current mode: *PM*');
  } else {
    await sendMessage(`Current mode: *Agent* — \`${mode.projectName}/${mode.provider}\``);
  }
}

/**
 * Route a non-slash message to the active agent. The output observer
 * (set up at mode switch) collects the reply and flushes on turn idle.
 *
 * Sanity guard: if the target tab session has disappeared (closed in Shelf
 * while we were in this mode), notify user and bounce back to PM.
 */
async function routeMessageToAgent(text: string): Promise<void> {
  if (mode.type !== 'agent') return; // defensive
  if (!isAgentTab(mode.tabId)) {
    await sendMessage('_The agent tab was closed in Shelf. Switching back to PM mode._');
    await switchToPmMode();
    if (onMessage && config) onMessage(text, config.chatId);
    return;
  }
  // Reset accumulator for the new turn. handleAgentEvent will fill it during
  // streaming and flush on idle.
  agentReplyBuffer.length = 0;
  agentTurnInProgress = false;
  // sendFromInternal returns when the turn loop exits. Errors propagate
  // through the observer as AgentEvent.error — not as a rejected promise.
  await sendFromInternal(mode.tabId, text);
}

/**
 * Observer callback for events flowing through the active agent session.
 * Accumulates reply text and flushes on idle. Permission/picker requests
 * trigger a "go to Shelf" fallback message (MVP — see plan).
 */
function handleAgentEvent(event: AgentEvent): void {
  // Defensive: if mode changed (user typed /pm mid-turn) we already
  // unsubscribed, but a race could land one stale event here. Drop it.
  if (mode.type !== 'agent') return;

  switch (event.type) {
    case 'status': {
      const state = event.payload.state;
      if (state === 'streaming') {
        agentTurnInProgress = true;
        agentReplyBuffer.length = 0;
      } else if (state === 'idle' && agentTurnInProgress) {
        agentTurnInProgress = false;
        flushAgentReply();
      }
      break;
    }
    case 'message': {
      const m = event.payload;
      if (m.type === 'reply') {
        agentReplyBuffer.push(m.content);
      } else if (m.type === 'error') {
        sendMessage(`❌ ${m.content}`).catch((e) => log.error('telegram', `error msg send failed: ${e.message}`));
      }
      // Other AgentMessage variants (note, system, fold_*, user) are
      // intentionally ignored in MVP — see plan's "MVP Wire 簡化".
      break;
    }
    case 'permission_request': {
      sendMessage(`🔒 Agent needs permission for \`${event.toolName}\`. Open Shelf to respond.`)
        .catch((e) => log.error('telegram', `permission notify failed: ${e.message}`));
      break;
    }
    case 'picker_request': {
      sendMessage('❓ Agent is asking a question. Open Shelf to respond.')
        .catch((e) => log.error('telegram', `picker notify failed: ${e.message}`));
      break;
    }
    case 'error': {
      sendMessage(`❌ ${event.error}`).catch((e) => log.error('telegram', `error notify failed: ${e.message}`));
      break;
    }
    // stream/plan/capabilities/auth_required: ignore in MVP.
  }
}

function flushAgentReply(): void {
  const text = agentReplyBuffer.join('');
  agentReplyBuffer.length = 0;
  if (text.length === 0) {
    sendMessage('_(turn ended with no reply — open Shelf for details)_')
      .catch((e) => log.error('telegram', `empty-reply notify failed: ${e.message}`));
    return;
  }
  sendMessage(text).catch((e) => log.error('telegram', `flush reply failed: ${e.message}`));
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
    throw new Error(`Telegram API ${method} failed ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  return json.result;
}

async function sendHelp(): Promise<void> {
  const lines = ['*Available commands*', ''];
  for (const c of BASE_COMMANDS) {
    lines.push(`/${c.command} — ${c.description}`);
  }
  const dynamic = buildUseCommands();
  if (dynamic.length > 0) {
    lines.push('');
    lines.push('*Agent shortcuts*');
    for (const c of dynamic) {
      lines.push(`/${c.command} — ${c.description}`);
    }
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
  // Mode-aware: PM mode stops PM agent loop; agent mode stops the agent turn.
  if (mode.type === 'agent') {
    await stopFromInternal(mode.tabId);
    await sendMessage('🛑 Agent turn cancelled.');
    return;
  }
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
