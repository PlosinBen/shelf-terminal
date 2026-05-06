import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, SlashResult } from './types';
import { getCopilotSessionToken, isAuthenticated, COPILOT_DEFAULT_HEADERS } from './copilot-auth';
import { needsCompaction as checkCompaction, splitForCompaction, truncateToolOutputs, buildCompactionPrompt } from '../compaction';
import { loadContext, saveContext } from '../context-store';
import type { HistoryMessage } from '../compaction';

type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message?: string };

interface CopilotModelRaw {
  id: string;
  name?: string;
  capabilities?: {
    type?: string;
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number };
    supports?: { vision?: boolean; streaming?: boolean; tool_calls?: boolean };
  };
  model_picker_enabled?: boolean;
}

const DEFAULT_MODEL = 'gpt-4o';
const REASONING_MODELS = new Set(['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini']);

// Copilot's /models endpoint doesn't say which API a model belongs to. We start
// every model on /chat/completions, fall back to /responses on
// `unsupported_api_for_model`, and cache the discovered choice in memory.
type ApiMode = 'chat' | 'responses';
const DEFAULT_API: ApiMode = 'chat';

function isApiMismatchError(err: unknown): boolean {
  const e = err as any;
  return e?.data?.error?.code === 'unsupported_api_for_model';
}

class RetryWithOtherApi extends Error {
  constructor() { super('unsupported_api_for_model — retry with other API'); }
}

const SLASH_COMMANDS = [
  { name: 'model', description: 'Pick or switch the current model' },
  { name: 'clear', description: 'Reset the conversation context' },
  { name: 'compact', description: 'Summarise old turns to free context window' },
  { name: 'context', description: 'Show token usage and context window' },
  { name: 'help', description: 'List available slash commands' },
];

async function fetchCopilotModels(session: { token: string; apiEndpoint: string }): Promise<CopilotModelRaw[]> {
  try {
    const res = await fetch(`${session.apiEndpoint}/models`, {
      headers: {
        'Authorization': `Bearer ${session.token}`,
        'Accept': 'application/json',
        ...COPILOT_DEFAULT_HEADERS,
      },
    });
    if (!res.ok) return [];
    const body = await res.json() as { data?: CopilotModelRaw[] };
    return body.data ?? [];
  } catch {
    return [];
  }
}

// Lazy-load Vercel AI SDK to keep startup fast
let openaiModule: typeof import('@ai-sdk/openai') | null = null;
let aiModule: typeof import('ai') | null = null;

async function getOpenAI() {
  if (!openaiModule) openaiModule = await import('@ai-sdk/openai');
  return openaiModule;
}
async function getAI() {
  if (!aiModule) aiModule = await import('ai');
  return aiModule;
}

// ── Tool definitions for Vercel AI SDK ──

async function buildTools(cwd: string) {
  const { tool, jsonSchema } = await getAI();

  return {
    read_file: tool({
      description: 'Read a file from the filesystem. Path is relative to the working directory.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd)' },
          offset: { type: 'number', description: 'Start line (0-based)' },
          limit: { type: 'number', description: 'Max lines to read' },
        },
        required: ['path'],
      } as const),
      execute: async ({ path: filePath, offset, limit }: { path: string; offset?: number; limit?: number }) => {
        const abs = path.resolve(cwd, filePath);
        const content = fs.readFileSync(abs, 'utf-8');
        if (offset !== undefined || limit !== undefined) {
          const lines = content.split('\n');
          const start = offset ?? 0;
          const end = limit ? start + limit : lines.length;
          return lines.slice(start, end).join('\n');
        }
        return content;
      },
    }),

    write_file: tool({
      description: 'Write content to a file, creating it if necessary.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd)' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      } as const),
      execute: async ({ path: filePath, content }: { path: string; content: string }) => {
        const abs = path.resolve(cwd, filePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
        return `Wrote ${content.length} bytes to ${filePath}`;
      },
    }),

    edit_file: tool({
      description: 'Replace an exact string in a file. old_string must match exactly.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd)' },
          old_string: { type: 'string', description: 'Exact text to find' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      } as const),
      execute: async ({ path: filePath, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
        const abs = path.resolve(cwd, filePath);
        const content = fs.readFileSync(abs, 'utf-8');
        if (!content.includes(old_string)) {
          return `Error: old_string not found in ${filePath}`;
        }
        fs.writeFileSync(abs, content.replace(old_string, new_string), 'utf-8');
        return `Edited ${filePath}`;
      },
    }),

    bash: tool({
      description: 'Execute a bash command. Returns stdout+stderr.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
        },
        required: ['command'],
      } as const),
      execute: async ({ command, timeout }: { command: string; timeout?: number }) => {
        try {
          const result = execSync(command, {
            cwd,
            timeout: timeout ?? 30000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
          });
          return result;
        } catch (err: any) {
          return `Exit code ${err.status ?? 1}\n${err.stdout ?? ''}${err.stderr ?? ''}`;
        }
      },
    }),

    list_directory: tool({
      description: 'List files and directories at a path.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (relative to cwd)' },
        },
        required: ['path'],
      } as const),
      execute: async ({ path: dirPath }: { path: string }) => {
        const abs = path.resolve(cwd, dirPath);
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      },
    }),
  };
}

interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
}

export function createCopilotBackend(): ServerBackend {
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;
  const contextWindows = new Map<string, number>();
  let currentModel = DEFAULT_MODEL;
  let currentEffort = 'medium';
  let modelMessages: ModelMessage[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let isRunning = false;
  let abortController: AbortController | null = null;
  let currentSessionId: string | null = null;
  // Tracks server-side state ID for the Responses API (stateful conversation chain).
  // When set, subsequent /responses calls pass previousResponseId and only the new
  // user message instead of replaying full history (which produces 404 not_found
  // because server-side tool_call IDs don't match client-replayed ones).
  let lastResponseId: string | null = null;
  // Which API each model uses, learned empirically. Populated on first
  // successful query per model. Models not yet seen default to DEFAULT_API.
  const apiCache = new Map<string, ApiMode>();

  function getApi(model: string): ApiMode {
    return apiCache.get(model) ?? DEFAULT_API;
  }

  function isResponsesModel(model: string): boolean {
    return getApi(model) === 'responses';
  }

  function persistContext() {
    if (!currentSessionId) return;
    const stateful = isResponsesModel(currentModel);
    saveContext({
      sessionId: currentSessionId,
      provider: 'copilot',
      // Stateful API: server holds state via lastResponseId, no need to save messages.
      modelMessages: stateful ? [] : modelMessages,
      totalInputTokens,
      totalOutputTokens,
      model: currentModel,
      updatedAt: Date.now(),
      ...(lastResponseId ? { lastResponseId } : {}),
    });
  }

  async function performCompaction(provider: any, model: string, systemPrompt: string) {
    const history: HistoryMessage[] = modelMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: (m.role === 'tool' ? 'assistant' : m.role) as HistoryMessage['role'],
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));

    const { head, tail } = splitForCompaction(history);
    if (head.length === 0) return;

    const truncated = truncateToolOutputs(head);
    const compactPrompt = buildCompactionPrompt(truncated);

    const { generateText } = await getAI();
    const result = await generateText({
      model: provider.chat(model),
      prompt: compactPrompt,
      maxTokens: 2000,
    });

    const summary = result.text;
    const tailAsModelMessages: ModelMessage[] = tail.map((m) => ({
      role: m.role as ModelMessage['role'],
      content: m.content,
    }));

    modelMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'assistant', content: `[Prior conversation summary]\n${summary}` },
      ...tailAsModelMessages,
    ];

    totalInputTokens = 0;
    totalOutputTokens = 0;
  }

  return {
    async gatherCapabilities(_cwd: string, sessionId?: string): Promise<ProviderCapabilities> {
      // Restore persisted model so the UI's currentModel reflects last session,
      // not the default. Without this, the UI flashes default → persisted model.
      if (sessionId && currentModel === DEFAULT_MODEL) {
        const persisted = loadContext(sessionId);
        if (persisted?.model) currentModel = persisted.model;
      }
      const session = await getCopilotSessionToken();
      const raw = await fetchCopilotModels(session);
      const chat = raw.filter((m) =>
        m.capabilities?.type !== 'embeddings' && m.model_picker_enabled !== false,
      );
      contextWindows.clear();
      for (const m of chat) {
        const w = m.capabilities?.limits?.max_context_window_tokens;
        if (w) contextWindows.set(m.id, w);
      }
      return {
        currentModel,
        models: chat.map((m) => ({
          value: m.id,
          displayName: m.name ?? m.id,
          vision: m.capabilities?.supports?.vision,
        })),
        permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
        effortLevels: ['low', 'medium', 'high'],
        slashCommands: SLASH_COMMANDS,
        authMethod: {
          kind: 'oauth' as const,
          instructions: [
            { label: 'Credentials are read from ~/.config/github-copilot/ or gh CLI on this machine.' },
            { label: 'Sign in with GitHub CLI', command: 'gh auth login -s copilot' },
          ],
        },
      };
    },

    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      if (input.model) currentModel = input.model;
      if (input.effort) currentEffort = input.effort;
      if (input.sessionId) currentSessionId = input.sessionId;

      let session;
      try {
        session = await getCopilotSessionToken();
      } catch {
        send({ type: 'auth_required', provider: 'copilot' });
        send({ type: 'status', state: 'idle' });
        return;
      }

      abortController = new AbortController();
      isRunning = true;

      const { createOpenAI } = await getOpenAI();
      const { streamText } = await getAI();

      const provider = createOpenAI({
        apiKey: session.token,
        baseURL: session.apiEndpoint,
        headers: COPILOT_DEFAULT_HEADERS,
      });

      const systemPrompt = `You are a helpful AI coding assistant running inside a terminal UI.
You have access to tools for working with the user's codebase.
Rules:
- Keep responses concise. Prefer direct action over commentary.
- When editing, prefer Edit over Write for targeted changes.
- Always read a file before editing it.
- Don't make assumptions about the codebase — inspect it.`;

      // Load persisted context on first query
      if (modelMessages.length === 0 && lastResponseId == null && currentSessionId) {
        const persisted = loadContext(currentSessionId);
        if (persisted) {
          modelMessages = (persisted.modelMessages ?? []) as ModelMessage[];
          totalInputTokens = persisted.totalInputTokens;
          totalOutputTokens = persisted.totalOutputTokens;
          if (persisted.model) currentModel = persisted.model;
          if (persisted.lastResponseId) lastResponseId = persisted.lastResponseId;
        }
      }

      if (modelMessages.length === 0) {
        modelMessages.push({ role: 'system', content: systemPrompt });
      }
      modelMessages.push({ role: 'user', content: input.prompt });

      send({ type: 'status', state: 'streaming', model: currentModel });

      const tools = await buildTools(input.cwd);
      const isReasoning = REASONING_MODELS.has(currentModel);

      // Run streamText with a given API mode. Returns whether the call ran
      // stateful (i.e. used Responses API). Throws RetryWithOtherApi when the
      // server rejects this API for the model — must happen before any stream
      // event is dispatched to the user.
      const runStream = async (api: ApiMode): Promise<void> => {
        const stateful = api === 'responses';
        const model = stateful ? provider(currentModel) : provider.chat(currentModel);

        // Stateful: server holds context, send only new user message + previousResponseId.
        // Stateless: replay full history (Chat Completions style).
        const messagesToSend = stateful
          ? [{ role: 'user' as const, content: input.prompt }]
          : modelMessages.slice(1);

        // Copilot's /responses doesn't accept `store` param (OpenAI does);
        // Copilot appears to always retain state. We only pass previousResponseId
        // when chaining a follow-up turn.
        const providerOptions = stateful && lastResponseId
          ? { openai: { previousResponseId: lastResponseId } }
          : undefined;

        const result = streamText({
          model,
          system: systemPrompt,
          messages: messagesToSend as any,
          tools,
          maxSteps: 25,
          abortSignal: abortController!.signal,
          ...(isReasoning ? { reasoningEffort: currentEffort as any } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        });

        let streamStarted = false;
        try {
          for await (const part of result.fullStream) {
            if (abortController!.signal.aborted) break;
            streamStarted = true;

            switch (part.type) {
              case 'text-delta':
                send({ type: 'stream', streamType: 'text', content: part.text });
                break;
              case 'reasoning-delta':
                send({ type: 'stream', streamType: 'thinking', content: part.text });
                break;
              case 'tool-call':
                send({
                  type: 'message', msgType: 'tool_use', content: '',
                  toolName: part.toolName, toolInput: part.input,
                  toolUseId: part.toolCallId,
                });
                break;
              case 'tool-result': {
                const out = part.output as any;
                const resultText = typeof out === 'string' ? out : JSON.stringify(out ?? '');
                send({
                  type: 'message', msgType: 'tool_result',
                  content: resultText.slice(0, 8000),
                  toolUseId: part.toolCallId,
                });
                break;
              }
              case 'finish': {
                const usage = part.usage;
                if (usage) {
                  totalInputTokens += usage.inputTokens ?? 0;
                  totalOutputTokens += usage.outputTokens ?? 0;
                }
                break;
              }
              case 'error': {
                const msg = part.error instanceof Error ? part.error.message : String(part.error);
                if (isApiMismatchError(part.error)) throw new RetryWithOtherApi();
                // Responses API streaming has a known ID-mismatch bug emitting
                // "text part {id} not found"; text still arrives correctly so we
                // suppress these (BerriAI/litellm#19125, vercel/ai#8216).
                if (stateful && msg.includes('not found')) {
                  console.error('[copilot] suppressed responses-api stream error:', msg);
                  break;
                }
                send({ type: 'error', error: msg });
                break;
              }
            }
          }
        } catch (err) {
          // Retry signal bubbles up regardless of streamStarted (mismatch error
          // can arrive as a stream 'error' part after iteration begins).
          if (err instanceof RetryWithOtherApi) throw err;
          // For other thrown errors before any stream event, treat unsupported_api
          // as a retry signal too.
          if (!streamStarted && isApiMismatchError(err)) throw new RetryWithOtherApi();
          throw err;
        }

        if (!abortController!.signal.aborted) {
          try {
            const resp = await result.response;
            if (stateful) {
              if (resp.id) lastResponseId = resp.id;
            } else if (resp.messages?.length) {
              for (const msg of resp.messages) {
                modelMessages.push(msg as ModelMessage);
              }
            }
          } catch { /* response may not resolve on edge cases */ }
        }
      };

      try {
        const initialApi = getApi(currentModel);
        try {
          await runStream(initialApi);
          apiCache.set(currentModel, initialApi);
        } catch (err) {
          if (err instanceof RetryWithOtherApi) {
            const fallbackApi: ApiMode = initialApi === 'chat' ? 'responses' : 'chat';
            console.error(`[copilot] ${currentModel} unsupported on ${initialApi}, retrying via ${fallbackApi}`);
            await runStream(fallbackApi);
            apiCache.set(currentModel, fallbackApi);
          } else {
            throw err;
          }
        }
        const stateful = isResponsesModel(currentModel);

        send({
          type: 'status', state: 'idle', model: currentModel,
          inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        });

        // Auto-compaction is for stateless mode only. Stateful API manages
        // its own context server-side (same way we delegate to Claude SDK).
        if (!stateful) {
          const contextWindow = contextWindows.get(currentModel) ?? 128_000;
          const totalTokens = totalInputTokens + totalOutputTokens;
          if (checkCompaction(totalTokens, contextWindow)) {
            console.error(`[copilot] Auto-compaction triggered at ${totalTokens}/${contextWindow} tokens`);
            try {
              await performCompaction(provider, currentModel, systemPrompt);
              send({ type: 'message', msgType: 'system', content: '[Context compacted to stay within limits]' });
            } catch (err: any) {
              console.error(`[copilot] Compaction failed: ${err.message}`);
            }
          }
        }

        persistContext();
      } catch (err: any) {
        if (!abortController.signal.aborted) {
          send({ type: 'error', error: `Copilot error: ${err.message ?? String(err)}` });
        }
        send({ type: 'status', state: 'idle' });
      } finally {
        isRunning = false;
        for (const resolve of pendingPermissions.values()) {
          resolve({ behavior: 'deny', message: 'Session ended' });
        }
        pendingPermissions.clear();
      }
    },

    async stop() {
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
      abortController?.abort();
    },

    dispose() {
      abortController?.abort();
    },

    resolvePermission(toolUseId: string, allow: boolean, message?: string) {
      const resolve = pendingPermissions.get(toolUseId);
      if (resolve) {
        pendingPermissions.delete(toolUseId);
        resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: message ?? 'Denied' });
      }
    },

    async handleSlashCommand(cmd: string, args: string): Promise<SlashResult> {
      switch (cmd) {
        case 'model': {
          const arg = args.trim();
          let session;
          try {
            session = await getCopilotSessionToken();
          } catch {
            return { type: 'error', message: 'Authentication required to refresh model list' };
          }
          const raw = await fetchCopilotModels(session);
          const chat = raw.filter((m) =>
            m.capabilities?.type !== 'embeddings' && m.model_picker_enabled !== false,
          );
          contextWindows.clear();
          for (const m of chat) {
            const w = m.capabilities?.limits?.max_context_window_tokens;
            if (w) contextWindows.set(m.id, w);
          }
          const models = chat.map((m) => ({
            value: m.id,
            displayName: m.name ?? m.id,
            vision: m.capabilities?.supports?.vision,
          }));
          if (!arg) {
            return { type: 'show-model-picker', models, current: currentModel };
          }
          const match = models.find((m) => m.value === arg);
          if (!match) return { type: 'error', message: `Unknown model: ${arg}` };
          // Switching model invalidates any prior Responses API state — different
          // model family may not share session storage.
          if (arg !== currentModel) lastResponseId = null;
          currentModel = arg;
          return { type: 'switch-model', model: arg };
        }

        case 'clear': {
          modelMessages = [];
          totalInputTokens = 0;
          totalOutputTokens = 0;
          lastResponseId = null;
          persistContext();
          return { type: 'context-cleared', message: 'Context cleared' };
        }

        case 'context': {
          const window = contextWindows.get(currentModel) ?? 128_000;
          const total = totalInputTokens + totalOutputTokens;
          const pct = Math.round((total / window) * 100);
          return {
            type: 'system-message',
            content: `Token usage: ${total.toLocaleString()} / ${window.toLocaleString()} (${pct}%)\nInput: ${totalInputTokens.toLocaleString()}  Output: ${totalOutputTokens.toLocaleString()}\nModel: ${currentModel}`,
          };
        }

        case 'compact': {
          if (isResponsesModel(currentModel)) {
            return { type: 'system-message', content: `${currentModel} manages context server-side; /compact has no effect. Use /clear to reset.` };
          }
          if (modelMessages.length === 0) {
            return { type: 'system-message', content: 'No history to compact' };
          }
          let session;
          try {
            session = await getCopilotSessionToken();
          } catch {
            return { type: 'error', message: 'Authentication required for compaction' };
          }
          const { createOpenAI } = await getOpenAI();
          const provider = createOpenAI({
            apiKey: session.token,
            baseURL: session.apiEndpoint,
            headers: COPILOT_DEFAULT_HEADERS,
          });
          const systemPrompt = modelMessages.find((m) => m.role === 'system')?.content as string ?? '';
          try {
            await performCompaction(provider, currentModel, systemPrompt);
            persistContext();
            return { type: 'system-message', content: 'Context compacted' };
          } catch (err: any) {
            return { type: 'error', message: `Compaction failed: ${err.message ?? String(err)}` };
          }
        }

        case 'help': {
          const list = SLASH_COMMANDS.map((c) => `- /${c.name} — ${c.description}`).join('\n');
          return { type: 'system-message', content: `Available commands:\n${list}` };
        }

        default:
          return { type: 'error', message: `Unknown command: /${cmd}` };
      }
    },
  };
}
