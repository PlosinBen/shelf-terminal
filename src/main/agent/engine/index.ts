import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { AgentEvent, AgentQueryOptions, ProviderCapabilities } from '../types';
import type { AuthMethod, ModelInfo, SlashCommand } from './types';
import type { HistoryStore } from './history-store';
import { log } from '@shared/logger';
import { TOOLS, toolsForMode, toOpenAIFormat, shouldAllowAutomatically, shouldDenyAutomatically, buildSystemPrompt, SLASH_COMMANDS, getEffortLevels } from '../tools/registry';
import type { ToolExecutor } from '../tools/executor';

const DEFAULT_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

export interface EngineConfig {
  apiKey?: string;
  baseURL?: string;
  defaultModel: string;
  providerName: string;
  defaultHeaders?: Record<string, string>;
  /** Called before each request. Returns { apiKey, baseURL? } to use for this call. */
  tokenProvider?: () => Promise<{ apiKey: string; baseURL?: string }>;
  toolExecutor?: ToolExecutor;
  /** Lookup context window size (tokens) for a given model id. */
  getContextWindow?: (model: string) => number | undefined;
  /** Custom fetch for the underlying OpenAI client — use this to intercept
   * response headers (e.g. Copilot quota). */
  fetch?: typeof fetch;
  /** Optional callback polled after each turn to attach rate limit / quota
   * info to the status event. */
  getRateLimit?: () => { rateLimitType?: string; utilization?: number; resetsAt?: number } | null;

  // ── Method-per-capability hooks (v0.8) ────────────────────────────────────
  /** Returns the current list of models. Providers fetch dynamically (Copilot)
   * or return a static list (Gemini). Defaults to []. */
  getModels?: () => Promise<ModelInfo[]>;
  /** Permission modes exposed in the UI. Defaults to the four standard ones. */
  permissionModes?: string[];
  /** Effort levels exposed in the UI (engine-wide; per-model filtering is done
   * elsewhere via ModelInfo.effortLevels). Defaults to []. */
  effortLevels?: string[];
  /** How the UI should surface the authentication flow. Defaults to 'none'. */
  authMethod?: AuthMethod;
  /** Whether the provider has valid credentials to run right now. */
  customCheckAuth?: () => Promise<boolean>;
  /** Persist a static API key to the target machine. Only meaningful when
   * authMethod.kind === 'api-key'. Adapter should validate the key (e.g.
   * probe the provider API) before calling its store's set(). */
  storeCredential?: (key: string) => Promise<void>;
  /** Wipe the stored credential so the next query falls back to env var
   * (or fails with auth_required). */
  clearCredential?: () => Promise<void>;

  /** Optional persistence adapter. When provided, the engine loads existing
   * history on the first query that has a sessionId and saves after every
   * successful turn. Missing/null means in-memory-only (pre-persistence
   * behaviour — transcripts reset on app restart). */
  historyStore?: HistoryStore;

  /** Called when `/compact` runs — lets the provider substitute a cheaper
   * model for the summarisation call (gpt-4o-mini, gemini flash, etc.).
   * Return `undefined` to fall back to `currentModel`. Kept as a callback
   * (not a static string) because provider state like "is this model in
   * the user's Copilot quota?" needs to be checked at call time. */
  pickCompactModel?: (currentModel: string) => string | undefined;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const MAX_TURNS = 20;
const AUTO_COMPACT_THRESHOLD = 0.8;

function safeParseJSON(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return { _raw: s }; }
}

// One-line summary of a tool input for debug logs. We don't dump full content
// (Write / Edit payloads are huge and may be sensitive) — just enough to
// correlate a log line with what the agent tried to do.
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const clip = (s: unknown, n = 80): string => {
    const str = typeof s === 'string' ? s : String(s ?? '');
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `path=${clip(input.file_path, 120)}`;
    case 'Bash':
      return `cmd=${clip(input.command, 120)}`;
    case 'Grep':
      return `pattern=${clip(input.pattern)} path=${clip(input.path ?? '.', 60)}`;
    case 'Glob':
      return `pattern=${clip(input.pattern)} path=${clip(input.path ?? '.', 60)}`;
    case 'Ls':
      return `path=${clip(input.path ?? '.', 120)}`;
    default:
      return `keys=${Object.keys(input).join(',')}`;
  }
}


export function createEngine(config: EngineConfig) {
  let abortController: AbortController | null = null;
  let history: Message[] = [];
  let currentModel = config.defaultModel;
  let currentEffort: string | null = null;
  let lastUsage: { prompt: number; completion: number } | null = null;
  let turnCount = 0;
  // Engine-owned session identifier. Lazily initialised on the first query()
  // that lacks an inbound `resume` id — mirrors the Claude SDK's pattern so
  // session manager / renderer can treat both backends uniformly. Subsequent
  // turns emit the same id in every status event, which is what the session
  // manager captures and persists into ProjectConfig.agentSessionIds.
  let sessionId: string | undefined;
  // One-shot guard so we don't hit the store on every turn. Reset by
  // clearAllState() / clearHistory() when starting a new conversation.
  let historyLoaded = false;
  const createdAt = Date.now();

  // Shared "drop everything" path used by both the /clear slash command
  // (user typed it into the chat) and the public clearHistory() method
  // (external callers). Keeps the disk and in-memory state in lockstep.
  function clearAllState(): void {
    const oldId = sessionId;
    history = [];
    lastUsage = null;
    turnCount = 0;
    sessionId = undefined;
    historyLoaded = false;
    if (oldId && config.historyStore) {
      // Fire and forget — persistence cleanup shouldn't block the user's
      // next input. Errors are logged inside the adapter.
      config.historyStore.delete(oldId).catch(() => {});
    }
  }

  async function getClient(): Promise<OpenAI> {
    if (config.tokenProvider) {
      const { apiKey, baseURL } = await config.tokenProvider();
      return new OpenAI({ apiKey, baseURL: baseURL ?? config.baseURL, defaultHeaders: config.defaultHeaders, fetch: config.fetch });
    }
    return new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? 'dummy',
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
      fetch: config.fetch,
    });
  }

  // ── Shared compact logic — used by /compact and auto-compact ──────────────
  const COMPACT_PROMPT = [
    'Summarise the conversation above into a structured briefing I can use as context for continuing.',
    'Use the following sections (omit any section that has nothing to report):',
    '',
    '## Goal',
    'What the user is trying to accomplish overall.',
    '',
    '## Completed',
    'What has been done so far — decisions made, problems solved, commands run.',
    '',
    '## Relevant files',
    'File paths that were read, created, or modified (list only, no descriptions).',
    '',
    '## Open questions / issues',
    'Unresolved problems, unanswered questions, known blockers.',
    '',
    '## Current task / next steps',
    'What was in progress or about to start when the conversation was compacted.',
    '',
    'Be concise — aim for ~250 words total. Drop chitchat, resolved exchanges, and verbose thinking.',
  ].join('\n');

  /**
   * Compact older turns into a structured summary, keeping the last 2 user
   * turns verbatim. Returns `{ summary, compactedCount }` on success, or
   * `null` when there's not enough history to compact.
   */
  async function performCompact(): Promise<{ summary: string; compactedCount: number } | null> {
    if (history.length < 4) return null;

    const systemMsg = history[0]?.role === 'system' ? history[0] : null;
    let userSeen = 0;
    let splitIdx = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        userSeen++;
        if (userSeen === 2) { splitIdx = i; break; }
      }
    }
    const head = systemMsg ? 1 : 0;
    const toCompact = history.slice(head, splitIdx);
    const toKeep = history.slice(splitIdx);
    if (toCompact.length === 0) return null;

    const oai = await getClient();
    const compactModel = config.pickCompactModel?.(currentModel) ?? currentModel;
    if (compactModel !== currentModel) {
      log.info('agent-engine', `compact model.switch from=${currentModel} to=${compactModel}`);
    }
    const result = await oai.chat.completions.create({
      model: compactModel,
      messages: [
        ...(systemMsg ? [systemMsg] : []),
        ...toCompact,
        { role: 'user', content: COMPACT_PROMPT },
      ] as any,
      stream: false,
    });
    const summary = result.choices[0]?.message?.content ?? '(empty summary)';

    history = [
      ...(systemMsg ? [systemMsg] : []),
      { role: 'assistant', content: `[Compacted context from earlier turns]\n\n${summary}` },
      ...toKeep,
    ];
    return { summary, compactedCount: toCompact.length };
  }

  return {
    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      abortController = new AbortController();

      // Resolve sessionId precedence: external resume id (from caller) > already
      // held id > freshly minted. Once set it sticks for the engine's lifetime
      // until clearAllState() wipes it.
      if (opts?.resume) {
        sessionId = opts.resume;
      } else if (!sessionId) {
        sessionId = randomUUID();
        log.debug('agent-engine', `session.new id=${sessionId} provider=${config.providerName}`);
      }

      // Hydrate in-memory history from disk on the first entry for this
      // session. Done once per session (historyLoaded guard) so subsequent
      // turns hit the in-memory array only. Failure is non-fatal: we log,
      // continue with an empty history, and the next save() will overwrite.
      // The defensive try/catch means even a buggy third-party adapter
      // can't eat a user's turn.
      if (!historyLoaded && config.historyStore && sessionId) {
        try {
          const restored = await config.historyStore.load(sessionId);
          if (restored && restored.messages.length > 0) {
            history = [...restored.messages];
            log.info(
              'agent-engine',
              `history.restored id=${sessionId} provider=${config.providerName} messages=${restored.messages.length}`,
            );
          }
        } catch (err: any) {
          log.info('agent-engine', `history.load threw id=${sessionId}: ${err?.message ?? err} — continuing with empty history`);
        }
        historyLoaded = true;
      }

      const mode = opts?.permissionMode ?? 'default';

      const trimmed = prompt.trim();
      let ephemeral = false;
      let actualPrompt = prompt;

      if (trimmed.toLowerCase().startsWith('/ask ') || trimmed.toLowerCase() === '/ask') {
        const rest = trimmed.slice(4).trim();
        if (!rest) {
          yield { type: 'message', payload: { type: 'text', content: 'Usage: `/ask <question>` — sends a one-off query that is not saved to history.' } };
          yield { type: 'status', payload: { state: 'idle', model: currentModel, sessionId } };
          return;
        }
        actualPrompt = rest;
        ephemeral = true;
      } else if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        const arg = rest.join(' ').trim();
        const reply = await handleSlash(cmd, arg, cwd, mode);
        if (reply !== null) {
          yield { type: 'message', payload: { type: 'text', content: reply } };
          yield { type: 'status', payload: { state: 'idle', model: currentModel, sessionId } };
          return;
        }
      }

      const projectInstructions = (await config.toolExecutor?.loadProjectInstructions(cwd)) ?? undefined;
      const systemPrompt = buildSystemPrompt(cwd, mode, projectInstructions);
      if (history.length > 0 && history[0].role === 'system') {
        history[0].content = systemPrompt;
      } else {
        history.unshift({ role: 'system', content: systemPrompt });
      }
      const ephemeralStartLen = history.length;
      // If images accompany the turn, use OpenAI's multimodal content array.
      const images = opts?.images ?? [];
      if (images.length > 0) {
        const parts: ContentPart[] = images
          .filter((u) => u.startsWith('data:image/'))
          .map((url) => ({ type: 'image_url', image_url: { url } }));
        if (actualPrompt) parts.push({ type: 'text', text: actualPrompt });
        history.push({ role: 'user', content: parts });
      } else {
        history.push({ role: 'user', content: actualPrompt });
      }

      const tools = toOpenAIFormat(toolsForMode(mode));

      yield { type: 'status', payload: { state: 'streaming', model: currentModel, sessionId } };

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          // Re-resolve per turn so long agent runs refresh tokens that expire
          // mid-flight (Copilot session tokens are ~30min TTL); tokenProvider
          // caches and only re-fetches when <60s of life remain.
          const oai = await getClient();
          const supportedEfforts = getEffortLevels(currentModel);
          const effort = (supportedEfforts.length > 0 && currentEffort && supportedEfforts.includes(currentEffort))
            ? currentEffort : undefined;
          const params = {
            model: currentModel,
            messages: history as any,
            tools: tools.length > 0 ? tools : undefined,
            stream: true as const,
            stream_options: { include_usage: true },
            ...(effort ? { reasoning_effort: effort as any } : {}),
          };
          log.debug('agent-engine', `turn=${turn} provider=${config.providerName} model=${currentModel} effort=${effort ?? '-'} history=${history.length}`);
          const turnStart = Date.now();
          const stream = await oai.chat.completions.create(params, { signal: abortController.signal });

          let content = '';
          let reasoning = '';
          const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
          let finishReason: string | null = null;
          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

          for await (const chunk of stream) {
            if (chunk.usage) usage = chunk.usage as any;
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta as any;
            if (!delta) continue;

            // OpenAI reasoning models (o-series, gpt-5) stream thinking separately
            // in delta.reasoning_content or delta.reasoning. Both aliases in the wild.
            const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
              reasoning += reasoningDelta;
              yield { type: 'stream', payload: { type: 'thinking', content: reasoningDelta } };
            }

            if (delta.content) {
              content += delta.content;
              yield { type: 'stream', payload: { type: 'text', content: delta.content } };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const slot = toolCalls[idx] ?? (toolCalls[idx] = { id: '', name: '', args: '' });
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (tc.function?.arguments) slot.args += tc.function.arguments;
              }
            }
          }

          const calls = Object.values(toolCalls).filter((c) => c.name);

          log.debug('agent-engine', `turn=${turn}.end duration=${Date.now() - turnStart}ms finish=${finishReason ?? '-'} contentLen=${content.length} reasoningLen=${reasoning.length} toolCalls=${calls.length}${calls.length > 0 ? ` [${calls.map(c => c.name).join(',')}]` : ''}`);

          // Emit thinking as a message (UI renders a collapsible block).
          // Do not push reasoning back into history — OpenAI reasoning models
          // must not receive their own prior reasoning in subsequent calls.
          if (reasoning) {
            yield { type: 'message', payload: { type: 'thinking', content: reasoning } };
          }

          if (content || calls.length > 0) {
            history.push({
              role: 'assistant',
              content: content || null,
              tool_calls: calls.length > 0
                ? calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
                : undefined,
            });
          }

          if (content) {
            yield { type: 'message', payload: { type: 'text', content } };
          }

          if (usage) {
            lastUsage = { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 };
            turnCount++;
            const contextWindow = config.getContextWindow?.(currentModel);
            const rateLimit = config.getRateLimit?.() ?? undefined;
            yield {
              type: 'status',
              payload: {
                state: calls.length > 0 ? 'streaming' : 'idle',
                model: currentModel,
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                contextUsedTokens: usage.prompt_tokens,
                contextWindow,
                rateLimit: rateLimit ?? undefined,
                sessionId,
              },
            };
          }

          if (calls.length === 0 || finishReason !== 'tool_calls') {
            break;
          }

          for (const call of calls) {
            const toolInput = safeParseJSON(call.args);
            const category = TOOLS[call.name]?.category ?? 'exec';

            yield {
              type: 'message',
              payload: {
                type: 'tool_use', content: '',
                toolName: call.name, toolInput, toolUseId: call.id,
              },
            };

            let resultText: string | null = null;

            if (shouldDenyAutomatically(mode, category)) {
              resultText = `Denied: tool ${call.name} (${category}) is not allowed in ${mode} mode`;
            } else if (!shouldAllowAutomatically(mode, category) && opts?.canUseTool) {
              const decision = await opts.canUseTool(call.id, call.name, toolInput);
              if (decision.behavior === 'deny') {
                resultText = `Denied by user${decision.message ? `: ${decision.message}` : ''}`;
              }
            }

            if (resultText === null) {
              const toolStart = Date.now();
              log.debug('agent-engine', `tool.start name=${call.name} category=${category} ${summarizeToolInput(call.name, toolInput)}`);
              try {
                if (!config.toolExecutor) throw new Error('Tool executor not configured');
                resultText = await config.toolExecutor.execute(call.name, toolInput, cwd);
                log.debug('agent-engine', `tool.done name=${call.name} duration=${Date.now() - toolStart}ms resultLen=${resultText.length}`);
              } catch (err: any) {
                log.error('agent-engine', `Tool ${call.name} failed (${Date.now() - toolStart}ms): ${err?.message ?? err}`);
                resultText = `Error: ${err.message ?? 'tool execution failed'}`;
              }
            }

            history.push({ role: 'tool', tool_call_id: call.id, content: resultText });
            yield {
              type: 'message',
              payload: { type: 'tool_result', content: resultText, toolUseId: call.id },
            };
          }
        }

        // ── Auto-compact: if prompt_tokens exceeded 80% of context window,
        // compact now so the *next* turn has room. Runs after the turn loop
        // finishes (model already replied) and before persist — the persisted
        // history will already be the compacted version.
        if (!ephemeral && lastUsage) {
          const contextWindow = config.getContextWindow?.(currentModel);
          if (contextWindow && contextWindow > 0) {
            const used = lastUsage.prompt + lastUsage.completion;
            const ratio = used / contextWindow;
            if (ratio >= AUTO_COMPACT_THRESHOLD) {
              log.info('agent-engine', `auto-compact triggered ratio=${(ratio * 100).toFixed(1)}% (${used}/${contextWindow}) provider=${config.providerName}`);
              try {
                const compactResult = await performCompact();
                if (compactResult) {
                  log.info('agent-engine', `auto-compact done compacted=${compactResult.compactedCount} historyAfter=${history.length}`);
                  yield {
                    type: 'message',
                    payload: {
                      type: 'system',
                      content: `Context reached ${(ratio * 100).toFixed(0)}% — auto-compacted ${compactResult.compactedCount} earlier messages.`,
                    },
                  };
                }
              } catch (err: any) {
                // Auto-compact is best-effort — never block the user's reply.
                log.error('agent-engine', `auto-compact failed: ${err?.message ?? err}`);
              }
            }
          }
        }

        // Persist the fully-consistent history before announcing idle.
        // Skipped for /ask turns (ephemeral === true) because those
        // explicitly drop their contribution in the finally block.
        // Errors in save() are logged inside the adapter and do not
        // propagate — a disk hiccup shouldn't eat the user's reply.
        if (!ephemeral && sessionId && config.historyStore) {
          const head = history[0]?.role === 'system' ? 1 : 0;
          const toPersist = history.slice(head);
          await config.historyStore.save({
            version: 1,
            sessionId,
            providerName: config.providerName,
            messages: toPersist,
            model: currentModel,
            createdAt,
            updatedAt: Date.now(),
          });
        }

        yield { type: 'status', payload: { state: 'idle', model: currentModel, sessionId } };
      } catch (err: any) {
        if (err?.message === 'NO_AUTH') throw err;
        if (err.name === 'AbortError') {
          // Normally user-initiated stop, but can also fire from unexpected
          // signal races. Log so silent exits aren't invisible in the trail.
          log.info('agent-engine', `Query aborted (history=${history.length})`);

          // ── Sanitize history after abort ──────────────────────────────
          // If the abort happened mid-tool-execution, the history may
          // contain an assistant message with tool_calls but missing some
          // (or all) tool result messages. The API requires every tool_call
          // to have a corresponding tool result; without it the next request
          // will 500. Walk backward to find the last assistant msg with
          // tool_calls, then check which results are missing.
          let assistantIdx = -1;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'assistant' && history[i].tool_calls && history[i].tool_calls!.length > 0) {
              assistantIdx = i;
              break;
            }
            // Stop searching once we hit a user message — anything before
            // that belongs to a prior completed turn.
            if (history[i].role === 'user') break;
          }
          if (assistantIdx >= 0) {
            const assistantMsg = history[assistantIdx];
            const expectedIds = new Set(assistantMsg.tool_calls!.map((tc) => tc.id));
            // Collect tool results that follow this assistant message
            for (let i = assistantIdx + 1; i < history.length; i++) {
              if (history[i].role === 'tool' && history[i].tool_call_id) {
                expectedIds.delete(history[i].tool_call_id!);
              }
            }
            if (expectedIds.size === assistantMsg.tool_calls!.length) {
              // No tool results at all — remove the incomplete assistant msg
              history.splice(assistantIdx);
              log.info('agent-engine', `abort.cleanup removed incomplete assistant message (${expectedIds.size} pending tool_calls)`);
            } else if (expectedIds.size > 0) {
              // Partial results — add synthetic results for the missing ones
              for (const id of expectedIds) {
                history.push({ role: 'tool', tool_call_id: id, content: '[Aborted by user]' });
              }
              log.info('agent-engine', `abort.cleanup added ${expectedIds.size} synthetic tool results`);
            }
          }

          // Persist the sanitized history so the next resume picks up
          // a valid conversation state.
          if (sessionId && config.historyStore) {
            const head = history[0]?.role === 'system' ? 1 : 0;
            const toPersist = history.slice(head);
            await config.historyStore.save({
              version: 1,
              sessionId,
              providerName: config.providerName,
              messages: toPersist,
              model: currentModel,
              createdAt,
              updatedAt: Date.now(),
            });
          }
        } else {
          log.error('agent-engine', `Query error: ${err.message}`);
          yield { type: 'error', error: err.message ?? 'Unknown error' };
        }
      } finally {
        abortController = null;
        if (ephemeral) {
          // Drop everything this /ask turn produced — user message, assistant
          // reply, and any tool round-trips — so context stays pristine.
          history = history.slice(0, ephemeralStartLen);
        }
      }
    },

    async stop() {
      abortController?.abort();
    },

    dispose() {
      abortController?.abort();
      abortController = null;
      history = [];
    },

    getHistory() {
      return [...history];
    },

    clearHistory() {
      clearAllState();
    },

    setModel(model: string) {
      currentModel = model;
    },

    getModel() {
      return currentModel;
    },

    setEffort(effort: string) {
      currentEffort = effort || null;
    },

    async getSlashCommands(): Promise<SlashCommand[]> {
      // Hide /signout when the provider has no credential to clear so the
      // autocomplete only advertises what actually works.
      return SLASH_COMMANDS.filter((c) => c.name !== 'signout' || !!config.clearCredential);
    },

    // ── Method-per-capability getters (v0.8) ───────────────────────────────
    async getModels(): Promise<ModelInfo[]> {
      return (await config.getModels?.()) ?? [];
    },

    getPermissionModes(): string[] {
      return config.permissionModes ?? DEFAULT_PERMISSION_MODES;
    },

    getEffortLevels(): string[] {
      return config.effortLevels ?? [];
    },

    getAuthMethod(): AuthMethod {
      return config.authMethod ?? { kind: 'none' };
    },

    async checkAuth(): Promise<boolean> {
      if (config.customCheckAuth) return config.customCheckAuth();
      return true;
    },

    async storeCredential(key: string): Promise<void> {
      if (!config.storeCredential) {
        throw new Error(`Provider ${config.providerName} does not support storing a credential`);
      }
      await config.storeCredential(key);
    },

    async clearCredential(): Promise<void> {
      if (!config.clearCredential) {
        throw new Error(`Provider ${config.providerName} does not support clearing a credential`);
      }
      await config.clearCredential();
    },

  };

  async function handleSlash(cmd: string, arg: string, cwd: string, mode: string): Promise<string | null> {
    switch (cmd) {
      case 'clear':
        log.info('agent-engine', `slash.clear provider=${config.providerName} historyDropped=${history.length} sessionId=${sessionId ?? '-'}`);
        clearAllState();
        return 'Conversation history cleared.';

      case 'compact': {
        log.info('agent-engine', `slash.compact provider=${config.providerName} historyLen=${history.length}`);
        const result = await performCompact();
        if (!result) return history.length < 4
          ? 'Not enough history to compact yet.'
          : 'Nothing older than recent turns to compact.';
        return `Compacted ${result.compactedCount} earlier messages.\n\n${result.summary}`;
      }

      case 'model':
        if (!arg) return null; // handled by renderer picker
        currentModel = arg;
        return `Model switched to \`${arg}\`.`;

      case 'context': {
        const window = config.getContextWindow?.(currentModel);
        const lines = [
          `Turns: ${turnCount}`,
          lastUsage
            ? `Last tokens: ${lastUsage.prompt} in / ${lastUsage.completion} out`
            : 'Last tokens: (no turn yet)',
        ];
        if (window && lastUsage) {
          const pct = Math.round((lastUsage.prompt / window) * 100);
          lines.push(`Context: ${lastUsage.prompt} / ${window} (${pct}%)`);
        } else if (window) {
          lines.push(`Context window: ${window} tokens`);
        }
        return lines.join('\n');
      }

      case 'status': {
        const window = config.getContextWindow?.(currentModel);
        const ctxLine = window && lastUsage
          ? `${lastUsage.prompt} / ${window} (${Math.round((lastUsage.prompt / window) * 100)}%)`
          : '—';
        return [
          `Model: \`${currentModel}\``,
          `Mode: \`${mode}\``,
          `Cwd: \`${cwd}\``,
          `Turns: ${turnCount}`,
          `Context: ${ctxLine}`,
        ].join('\n');
      }

      case 'tools': {
        const lines = ['Tools available in current mode:'];
        for (const t of Object.values(TOOLS)) {
          const blocked = (mode === 'plan' && t.category !== 'read');
          const marker = blocked ? '🚫' : '✅';
          lines.push(`${marker} \`${t.name}\` (${t.category}) — ${t.description}`);
        }
        if (mode === 'plan') {
          lines.push('', '_Plan mode hides exec/write tools from the model._');
        }
        return lines.join('\n');
      }

      case 'help': {
        const visible = SLASH_COMMANDS.filter((c) => c.name !== 'signout' || !!config.clearCredential);
        return ['Available slash commands:', ...visible.map((c) => `- \`/${c.name}\` — ${c.description}`)].join('\n');
      }

      case 'signout': {
        if (!config.clearCredential) return 'This provider does not store credentials here — sign out externally (e.g. `gh auth logout`).';
        await config.clearCredential();
        const method = config.authMethod;
        if (method?.kind === 'api-key') {
          return `Credential cleared. The next turn will prompt for the \`${method.envVar}\` key again.`;
        }
        return 'Credential cleared.';
      }

      default:
        return null;
    }
  }
}
