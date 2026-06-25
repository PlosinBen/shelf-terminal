import os from 'os';
import { net } from 'electron';
import { log } from '@shared/logger';
import type { TabInferredState, TelegramConfig } from '@shared/types';
import { isAwayMode, setAwayMode as setAwayModeState } from './away-mode';
import { snapshotTabs } from './tab-watcher';
import { setSyncCallback, getSyncedProjects } from './tools';
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
  aliasOrFallback,
} from './telegram-mode';
import { AgentReplyAccumulator } from './telegram-bridge-accumulator';

export type ListenerStopReason = 'bad-token' | 'bad-chat-id' | 'taken-over';

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT = 30; // seconds (Telegram long poll)
const MAX_MESSAGE_LENGTH = 4096;

// Per-turn channel hint appended to Telegram-relayed prompts (agent mode).
// Tells the agent it's replying into a phone chat so it adapts BOTH constraints
// that share this root cause: (1) Telegram renders no rich text here, so emit
// plain text; (2) screen + 4096-char limits, so stay short and list topics
// instead of dumping everything. Injected into the AGENT context only — the
// Shelf user bubble mirrors the original text (sendFromInternal's displayText
// arg), so this never shows in the UI. Soft guidance; the plain-text send +
// 4096 splitMessage still backstop a non-compliant reply.
const TELEGRAM_BRIEF_HINT =
  '\n\n[System note: your reply is delivered into a Telegram chat on a phone. ' +
  'Plain text only — no Markdown (no **bold**, _italics_, # headings, `code`, code fences, tables); it will not render and just clutters the screen. ' +
  'Keep it short. If the answer spans multiple topics or issues, just list the topic titles and let me ask which to expand — do not explain them all at once. ' +
  'For long code or command output, say "see Shelf" instead of pasting it.]';

// Mode 切換 + agent-view bridge — see pm-agent#12.
type Mode =
  | { type: 'pm' }
  | { type: 'agent'; tabId: string; projectName: string; provider: string };
let mode: Mode = { type: 'pm' };

// Per-agent-turn reply accumulator. The bridge handler is a permanent global
// observer (registered once at boot via initTelegramBridge), so the
// accumulator's lifetime spans the whole process. Turn-start reset is the
// caller's job (routeMessageToAgent before sendFromInternal); flush happens
// on the `idle` event. See telegram-bridge-accumulator.ts for the design
// constraint (telegram needs one complete message per turn).
const agentAccumulator = new AgentReplyAccumulator();

// Throttle clock for the "typing…" chat action. sendChatAction's indicator
// auto-expires after ~5s, so maybeSendTyping refreshes at most every 4s while
// agent events flow. Timestamp-only — NO timer to start/stop: when events stop
// the indicator clears itself, and flushAgentReply's reply send clears it
// immediately. See pm-agent#12 (loading indicator).
let lastTypingAt = 0;

// `true` once initTelegramBridge has registered the global observer. Guards
// against double-registration on hot reload / repeated init calls.
let bridgeObserverRegistered = false;

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

// Fires when the listener stops itself on a fatal/conflict error (bad token,
// bad chat id, or another instance grabbing the bot). The wiring layer turns
// PM Active off + notifies the user. NOT fired on user-initiated stopTelegram().
type ListenerStoppedCallback = (reason: ListenerStopReason) => void;
let onListenerStopped: ListenerStoppedCallback | null = null;
let getProjectsFn: (() => { name: string; connectionType: string }[]) | null = null;

export function setListenerStoppedCallback(cb: ListenerStoppedCallback): void {
  onListenerStopped = cb;
}

/**
 * Register the bridge's global agent-event observer. Call once at app boot.
 *
 * The observer is permanent — it lives for the whole process lifetime, which
 * is why this function isn't symmetric with a teardown. The handler internally
 * filters by `(mode active && tabId matches)` so it sees every agent tab's
 * events but only acts when the bridge is currently routing to that tab.
 *
 * Idempotent: extra calls are no-ops (guards hot-reload / re-init scenarios).
 */
export function initTelegramBridge(): void {
  if (bridgeObserverRegistered) return;
  registerOutputObserver(handleAgentEvent);
  bridgeObserverRegistered = true;
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

/**
 * Tear down listener-bound state. Called by both `stopTelegram` (user-
 * initiated, via PM Active off) and `stopOnError` (fatal/conflict error).
 * Keeping these unified ensures the sync-callback / pending refresh timer /
 * agent-reply buffer get cleaned in BOTH paths — an earlier split version
 * leaked the callback on 409 yield (see merge commit for pm-active-listener
 * integration).
 *
 * Does NOT unregister the global agent observer — it stays for the process
 * lifetime (see initTelegramBridge). The handler's mode-gate is what makes
 * "listener off" effectively silent the bridge: with `mode = pm`, no agent
 * events get forwarded to Telegram.
 */
function cleanupListener(): void {
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
  agentAccumulator.reset();
  mode = { type: 'pm' };
}

export function stopTelegram(): void {
  cleanupListener();
  log.info('telegram', 'stopped polling');
}

// Internal: stop the listener due to a fatal/conflict error and notify the
// wiring layer (→ PM Active off). Distinct from user-initiated stopTelegram().
function stopOnError(reason: ListenerStopReason): void {
  if (!polling) return;
  cleanupListener();
  log.info('telegram', `listener stopped: ${reason}`);
  onListenerStopped?.(reason);
}

/**
 * Escape Telegram legacy-Markdown special chars so user-controlled strings
 * (project names, derived aliases, hostnames) don't make the parser look for
 * matching `_..._` / `*...*` / `` `...` `` markers and return 400 Bad Request
 * ("can't parse entities"). Catches: `_`, `*`, `` ` ``, `[`, `]`.
 *
 * Critical for `/use_<alias>` lines — a single underscore in an unwrapped
 * command opens an italic span that never closes, breaking the whole message.
 * Telegram surfaces this as a generic 400 which our error classifier maps to
 * "bad chat id" — confusing but fits the listener-stop contract.
 *
 * Exported for testing only.
 */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*`[\]])/g, '\\$1');
}

async function sendControlAnnouncement(): Promise<void> {
  if (!config) return;
  // Prefer synced state (has tab info + ids for alias derivation). Falls back
  // to the simpler getProjectsFn shape if sync hasn't fired yet — early boot
  // edge case. See pm-agent#12 MVP scope.
  const synced = getSyncedProjects();
  const lines = [`🖥 Now controlled by *${escapeTelegramMarkdown(os.hostname())}*`, ''];
  if (synced.length > 0) {
    lines.push('*Projects:*');
    for (const proj of synced) {
      const hasAgent = proj.tabs.some((t) => isAgentTab(t.id));
      const safeName = escapeTelegramMarkdown(proj.name);
      if (hasAgent) {
        const alias = aliasOrFallback(proj.name, proj.id);
        const safeAlias = escapeTelegramMarkdown(alias);
        lines.push(`  • ${safeName} (${proj.connectionType}) → /use\\_${safeAlias}`);
      } else {
        lines.push(`  • ${safeName} (${proj.connectionType})`);
      }
    }
  } else {
    const projects = getProjectsFn?.() ?? [];
    if (projects.length === 0) {
      lines.push('_No projects._');
    } else {
      lines.push('*Projects:*');
      for (const p of projects) lines.push(`  • ${escapeTelegramMarkdown(p.name)} (${p.connectionType})`);
    }
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

// ── Generic interactive prompt over Telegram (inline buttons) ───────────────
// A reusable "ask the user a multiple-choice question remotely" transport. The
// web-permission router uses it when the user is Away; onAnswer fires with the
// chosen value when a button is tapped. Decoupled from any specific feature —
// callers supply the text + labelled values.
interface InteractivePrompt { onAnswer: (value: string) => void; messageId?: number }
const pendingInteractive = new Map<string, InteractivePrompt>();
let interactiveSeq = 0;

/** True when the bridge can actually deliver a message (polling + configured). */
export function isTelegramAvailable(): boolean {
  return polling && !!config?.botToken && !!config?.chatId;
}

/** Send an inline-button prompt; onAnswer fires once with the chosen value.
 *  Returns a promptId for later cancellation, or null if it couldn't be sent. */
export async function sendInteractivePrompt(
  text: string,
  options: { label: string; value: string }[],
  onAnswer: (value: string) => void,
): Promise<string | null> {
  if (!config) return null;
  interactiveSeq += 1;
  const promptId = `ip${interactiveSeq}`;
  pendingInteractive.set(promptId, { onAnswer });
  try {
    const res = await apiCall('sendMessage', {
      chat_id: config.chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [options.map((o) => ({ text: o.label, callback_data: `ip:${promptId}:${o.value}` }))] },
    });
    const entry = pendingInteractive.get(promptId);
    if (entry) entry.messageId = res?.message_id;
    return promptId;
  } catch (e: any) {
    pendingInteractive.delete(promptId);
    log.error('telegram', `interactive prompt send failed: ${e.message}`);
    return null;
  }
}

/** Withdraw a still-open prompt (e.g. answered in the desktop popup first). */
export async function cancelInteractivePrompt(promptId: string, note?: string): Promise<void> {
  const entry = pendingInteractive.get(promptId);
  if (!entry || !config) { pendingInteractive.delete(promptId); return; }
  pendingInteractive.delete(promptId);
  if (entry.messageId) {
    await apiCall('editMessageReplyMarkup', { chat_id: config.chatId, message_id: entry.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (note) await apiCall('editMessageText', { chat_id: config.chatId, message_id: entry.messageId, text: note, parse_mode: 'Markdown' }).catch(() => {});
  }
}

export async function sendMessage(text: string, opts?: { plain?: boolean }): Promise<void> {
  if (!config) return;

  // Split long messages. `plain` omits parse_mode so the text is sent verbatim
  // — used for agent-mode replies (the agent is told to emit plain text, and
  // dropping parse_mode means a stray `_`/`*` can't 400 the whole message).
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await apiCall('sendMessage', {
      chat_id: config.chatId,
      text: chunk,
      ...(opts?.plain ? {} : { parse_mode: 'Markdown' }),
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

/**
 * Routes one incoming Telegram message to the right handler. Slash commands
 * are dispatched here; non-slash text goes to current mode (PM or agent).
 * See pm-agent#12 mode state machine.
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
  // Drop any in-flight buffered reply — once `mode = 'pm'` the handler will
  // ignore further agent events, so an unflushed buffer would just leak into
  // the next agent-mode session.
  agentAccumulator.reset();
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

  // Reset buffer before switching — leftover content from the previous tab
  // would otherwise flush into the new tab's first idle.
  agentAccumulator.reset();

  mode = {
    type: 'agent',
    tabId: res.tabId,
    projectName: res.projectName,
    provider: res.provider,
  };

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
  // Reset accumulator for the new turn — observer will fill it as `reply`
  // events flow and emit a flush when the turn ends.
  agentAccumulator.reset();
  // Inject the brevity hint into the agent context, but mirror only the
  // original text to Shelf (3rd arg) so the user bubble stays clean.
  // sendFromInternal returns when the turn loop exits. Errors propagate
  // through the observer as AgentEvent.error — not as a rejected promise.
  await sendFromInternal(mode.tabId, text + TELEGRAM_BRIEF_HINT, text);
}

/**
 * Permanent global agent-event observer for the bridge. Registered once at
 * boot (initTelegramBridge) and lives the process lifetime; gates itself by
 * the current `mode` + matching tabId. Events for tabs we're not currently
 * forwarding to (or any event while in PM mode) are dropped on the floor.
 *
 * Accumulates reply text and flushes on idle. Permission/picker requests
 * trigger a "go to Shelf" fallback message (MVP — see plan).
 */
function handleAgentEvent(tabId: string, event: AgentEvent): void {
  // Two-stage gate:
  //   1. Bridge is in agent mode (not PM).
  //   2. Event is for the tab the bridge is currently routing to.
  // Anything else is silently dropped — the observer is permanent, so this is
  // where "not interested right now" decisions are made (NOT in dispatch).
  if (mode.type !== 'agent' || mode.tabId !== tabId) return;

  // Any agent activity refreshes the "typing…" indicator (throttled). When
  // events stop the indicator self-clears; the reply send below clears it too.
  maybeSendTyping();

  // Accumulator handles per-turn reply buffering. Idle event triggers flush.
  const result = agentAccumulator.onEvent(event);
  if (result) flushAgentReply(result.flush);

  switch (event.type) {
    case 'message': {
      const m = event.payload;
      if (m.type === 'error') {
        // Plain: m.content is agent-generated, may contain `_`/`*` → markdown
        // would 400 and swallow the error notification entirely.
        sendMessage(`❌ ${m.content}`, { plain: true }).catch((e) => log.error('telegram', `error msg send failed: ${e.message}`));
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
      // Plain: provider error text is freeform → avoid a markdown 400.
      sendMessage(`❌ ${event.error}`, { plain: true }).catch((e) => log.error('telegram', `error notify failed: ${e.message}`));
      break;
    }
    // stream/plan/capabilities/auth_required: ignore in MVP.
  }
}

function flushAgentReply(text: string): void {
  if (text.length === 0) {
    sendMessage('_(turn ended with no reply — open Shelf for details)_')
      .catch((e) => log.error('telegram', `empty-reply notify failed: ${e.message}`));
    return;
  }
  // Plain text: the agent is asked to emit no Markdown, and omitting parse_mode
  // means any stray special char can't 400 the send. sendMessage splits
  // >4096-char replies; sending also clears the "typing…" indicator.
  sendMessage(text, { plain: true }).catch((e) => log.error('telegram', `flush reply failed: ${e.message}`));
}

/**
 * Send a throttled "typing…" chat action so Telegram's header shows the agent
 * is working. Refreshed at most every 4s (the indicator self-expires after
 * ~5s); when agent events stop it clears on its own, and flushAgentReply's
 * message send clears it immediately. Fire-and-forget — failures are ignored.
 */
export function maybeSendTyping(): void {
  if (!config) return;
  const now = Date.now();
  if (now - lastTypingAt < 4000) return;
  lastTypingAt = now;
  apiCall('sendChatAction', { chat_id: config.chatId, action: 'typing' }).catch(() => {});
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
  } else if (data.startsWith('ip:')) {
    // Generic interactive prompt (e.g. web.fetch permission while Away).
    const parts = data.split(':');
    const promptId = parts[1];
    const value = parts.slice(2).join(':');
    const entry = pendingInteractive.get(promptId);
    if (entry) {
      pendingInteractive.delete(promptId);
      if (messageId) {
        await apiCall('editMessageReplyMarkup', {
          chat_id: config!.chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        await apiCall('editMessageText', {
          chat_id: config!.chatId,
          message_id: messageId,
          text: `${cbq.message?.text ?? ''}\n\n✓ ${value} at ${now}`,
          parse_mode: 'Markdown',
        }).catch(() => {});
      }
      entry.onAnswer(value);
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
