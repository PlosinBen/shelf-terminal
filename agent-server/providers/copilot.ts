import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities } from './types';
import { getCopilotSessionToken, isAuthenticated, COPILOT_DEFAULT_HEADERS } from './copilot-auth';
import { needsCompaction as checkCompaction, splitForCompaction, truncateToolOutputs, buildCompactionPrompt } from '../compaction';
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
  const { tool } = await getAI();
  const { z } = await import('zod');

  return {
    read_file: tool({
      description: 'Read a file from the filesystem. Path is relative to the working directory.',
      parameters: z.object({
        path: z.string().describe('File path (relative to cwd)'),
        offset: z.number().optional().describe('Start line (0-based)'),
        limit: z.number().optional().describe('Max lines to read'),
      }),
      execute: async ({ path: filePath, offset, limit }) => {
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
      parameters: z.object({
        path: z.string().describe('File path (relative to cwd)'),
        content: z.string().describe('Content to write'),
      }),
      execute: async ({ path: filePath, content }) => {
        const abs = path.resolve(cwd, filePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
        return `Wrote ${content.length} bytes to ${filePath}`;
      },
    }),

    edit_file: tool({
      description: 'Replace an exact string in a file. old_string must match exactly.',
      parameters: z.object({
        path: z.string().describe('File path (relative to cwd)'),
        old_string: z.string().describe('Exact text to find'),
        new_string: z.string().describe('Replacement text'),
      }),
      execute: async ({ path: filePath, old_string, new_string }) => {
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
      parameters: z.object({
        command: z.string().describe('Shell command to run'),
        timeout: z.number().optional().describe('Timeout in ms (default 30000)'),
      }),
      execute: async ({ command, timeout }) => {
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
      parameters: z.object({
        path: z.string().describe('Directory path (relative to cwd)'),
      }),
      execute: async ({ path: dirPath }) => {
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
      model: provider(model),
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
    async gatherCapabilities(_cwd: string): Promise<ProviderCapabilities> {
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
        slashCommands: [],
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

      // Add user message to model messages
      if (modelMessages.length === 0) {
        modelMessages.push({ role: 'system', content: systemPrompt });
      }
      modelMessages.push({ role: 'user', content: input.prompt });

      send({ type: 'status', state: 'streaming', model: currentModel });

      const tools = await buildTools(input.cwd);

      try {
        const isReasoning = REASONING_MODELS.has(currentModel);
        const result = streamText({
          model: provider(currentModel),
          system: systemPrompt,
          messages: modelMessages.slice(1) as any,
          tools,
          maxSteps: 25,
          abortSignal: abortController.signal,
          ...(isReasoning ? { reasoningEffort: currentEffort as any } : {}),
        });

        let assistantText = '';

        for await (const part of result.fullStream) {
          if (abortController.signal.aborted) break;

          switch (part.type) {
            case 'text-delta':
              assistantText += part.text;
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
              send({ type: 'error', error: msg });
              break;
            }
          }
        }

        if (assistantText.trim()) {
          send({
            type: 'message', msgType: 'text', content: assistantText,
          });
        }

        // Capture response messages for cross-turn memory
        if (!abortController.signal.aborted) {
          try {
            const resp = await result.response;
            if (resp.messages?.length) {
              for (const msg of resp.messages) {
                modelMessages.push(msg as ModelMessage);
              }
            }
          } catch { /* response may not resolve on edge cases */ }
        }

        send({
          type: 'status', state: 'idle', model: currentModel,
          inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        });

        // Auto-compaction check
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
  };
}
