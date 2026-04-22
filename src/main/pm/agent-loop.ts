import { BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { PmMessage, PmStreamChunk, PmProviderConfig } from '@shared/types';
import { log } from '@shared/logger';
import { streamChat, type ChatMessage, type ToolCall } from './llm-client';
import { getActiveToolSchemas, executeTool } from './tools';
import { isAwayMode } from './away-mode';
import { sendPmResponse, isRunning as isTelegramRunning } from './telegram';

const SYSTEM_PROMPT_BASE = `You are PM (Project Manager) for Shelf Terminal — a multi-project terminal management app.

Your role: observe all projects and their terminal tabs, understand what's happening, and help the user manage their work.

Guidelines:
- Use scan_all_tabs() first to get a global picture before answering questions
- Use read_scrollback(tabId, lines) to look deeper into a specific tab
- Maintain rolling summary notes for projects you actively observe (read_project_note / write_project_note)
- Notes follow this format: Active / Recently done / Open loops / Context hints — keep under ~300 words
- Be concise and direct. The user is a developer who wants actionable info, not verbose summaries
- When reporting tab states, mention the project name and tab name for context
- If a CLI agent appears stuck or errored, point it out proactively

You do NOT manage Shelf itself — no settings changes, no creating/removing projects, no keybindings.`;

const AWAY_MODE_OFF_ADDENDUM = `

Away Mode is OFF. You have read-only access. You can see terminal output and manage notes, but you CANNOT type into terminals.`;

const AWAY_MODE_ON_ADDENDUM = `

Away Mode is ON. You can write to terminals via write_to_pty(). Use it for:
1. Sending natural language prompts to CLI agents
2. Sending approve/deny keystrokes (y/n) when CLI asks for permission
3. Sending ESC (\\x1b) or Ctrl+C (\\x03) to interrupt a stuck CLI

CRITICAL RULES:
- NEVER write to idle_shell tabs (the tool will block this, but don't try)
- Default to APPROVE when a CLI asks permission for reasonable operations
- ESCALATE (refuse to approve and tell the user) for dangerous operations: rm -rf, git push --force, DROP TABLE, chmod 777, etc.
- If the tool returns REDLINE BLOCKED, do NOT retry — report to the user that the operation was blocked and why
- When sending a prompt to a CLI agent, end with \\n (newline) so it executes
- When approving, send just "y\\n"`;

function getSystemPrompt(): string {
  return SYSTEM_PROMPT_BASE + (isAwayMode() ? AWAY_MODE_ON_ADDENDUM : AWAY_MODE_OFF_ADDENDUM);
}

const MAX_HISTORY_TURNS = 40;

let history: ChatMessage[] = [];
let messages: PmMessage[] = [];
let abortController: AbortController | null = null;

export function getHistory(): PmMessage[] {
  return [...messages];
}

export function clearHistory(): void {
  history = [];
  messages = [];
}

export async function handleTabEvent(
  tabId: string,
  tabName: string,
  projectName: string,
  oldState: string,
  newState: string,
  config: PmProviderConfig,
  win: BrowserWindow,
): Promise<void> {
  const eventMsg = `[System Event] Tab "${tabName}" in project "${projectName}" changed state: ${oldState} → ${newState}. Please scan this tab and take appropriate action.`;
  log.info('pm', `auto-event: ${eventMsg}`);
  await handlePmSend(eventMsg, config, win);
}

export function stopGeneration(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

export async function handlePmSend(
  userMessage: string,
  config: PmProviderConfig,
  win: BrowserWindow,
): Promise<void> {
  const userMsg: PmMessage = { role: 'user', content: userMessage, timestamp: Date.now() };
  messages.push(userMsg);
  history.push({ role: 'user', content: userMessage });

  abortController = new AbortController();
  const { signal } = abortController;

  try {
    await runLoop(config, win, signal);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      sendChunk(win, { type: 'done' });
      return;
    }
    log.error('pm', `agent loop error: ${err.message}`);
    sendChunk(win, { type: 'error', error: err.message });
  } finally {
    abortController = null;
  }
}

async function runLoop(
  config: PmProviderConfig,
  win: BrowserWindow,
  signal: AbortSignal,
): Promise<void> {
  const MAX_TOOL_ROUNDS = 10;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Sliding window: keep last N turns, always include system prompt
    const trimmed = history.length > MAX_HISTORY_TURNS
      ? history.slice(-MAX_HISTORY_TURNS)
      : history;
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: getSystemPrompt() },
      ...trimmed,
    ];

    let assistantText = '';
    const toolCalls: Map<string, { name: string; args: string }> = new Map();

    for await (const event of streamChat(config, chatMessages, getActiveToolSchemas(), signal)) {
      if (signal.aborted) return;

      switch (event.type) {
        case 'text':
          assistantText += event.text!;
          sendChunk(win, { type: 'text', text: event.text! });
          break;
        case 'tool_call_start':
          toolCalls.set(event.toolCallId!, { name: event.toolName!, args: '' });
          break;
        case 'tool_call_args': {
          const tc = toolCalls.get(event.toolCallId!);
          if (tc) tc.args += event.argsChunk!;
          break;
        }
        case 'done':
          break;
      }
    }

    if (toolCalls.size === 0) {
      // No tool calls — final response
      history.push({ role: 'assistant', content: assistantText });
      messages.push({ role: 'assistant', content: assistantText, timestamp: Date.now() });
      sendChunk(win, { type: 'done' });
      // Mirror to Telegram
      if (assistantText && isTelegramRunning()) {
        sendPmResponse(assistantText).catch((e) => log.error('pm', `telegram send failed: ${e.message}`));
      }
      return;
    }

    // Execute tool calls
    const toolCallArray: ToolCall[] = [];
    const pmToolCalls: PmMessage['toolCalls'] = [];

    for (const [id, tc] of toolCalls) {
      toolCallArray.push({
        id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      });
    }

    history.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCallArray,
    });

    for (const tc of toolCallArray) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }

      sendChunk(win, {
        type: 'tool_start',
        toolCall: { id: tc.id, name: tc.function.name, args },
      });

      const result = executeTool(tc.function.name, args);

      history.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
      });

      pmToolCalls.push({ id: tc.id, name: tc.function.name, args, result });

      sendChunk(win, {
        type: 'tool_result',
        toolCall: { id: tc.id, name: tc.function.name, args, result },
      });
    }

    // Store assistant message with tool calls for display
    messages.push({
      role: 'assistant',
      content: assistantText,
      toolCalls: pmToolCalls,
      timestamp: Date.now(),
    });

    // Continue loop — LLM will see tool results and respond
  }

  // If we exhausted rounds, send what we have
  sendChunk(win, { type: 'error', error: 'Too many tool rounds' });
}

function sendChunk(win: BrowserWindow, chunk: PmStreamChunk): void {
  if (!win.isDestroyed()) {
    win.webContents.send(IPC.PM_STREAM, chunk);
  }
}
