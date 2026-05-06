import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, SlashResult, StatusSegment } from './types';
import { severityFromUtilization, formatResetCountdown } from './types';

const COPILOT_QUOTA_LABELS: Record<string, string> = {
  premium_interactions: 'premium',
  chat_interactions: 'chat',
};

const execFileP = promisify(execFile);

async function readGhToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token'], { timeout: 3000 });
    const tok = stdout.trim();
    return tok || undefined;
  } catch {
    return undefined;
  }
}

type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message?: string };

const DEFAULT_MODEL = 'gpt-5.5';

const SLASH_COMMANDS = [
  { name: 'model', description: 'Pick or switch the current model' },
  { name: 'context', description: 'Show context window usage' },
  { name: 'compact', description: 'Summarize conversation to free up context' },
  { name: 'clear', description: 'Reset the conversation context' },
  { name: 'help', description: 'List available slash commands' },
];

let sdkModule: typeof import('@github/copilot-sdk') | null = null;
async function getSdk() {
  if (!sdkModule) sdkModule = await import('@github/copilot-sdk');
  return sdkModule;
}

/**
 * Resolve the Copilot CLI binary path. The Copilot SDK spawns a CLI subprocess
 * (the CLI does the actual API/auth/state work; SDK is just a JSON-RPC wrapper).
 *
 * Mirrors how `claude.ts` resolves the Claude binary — checks dev node_modules
 * and packaged app.asar.unpacked locations.
 */
function resolveCopilotCliPath(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const platformPkg = `copilot-${platform}-${arch}`;

  // The @github/copilot package's index.js is the entry point that resolves the
  // platform-specific binary internally. Pass it as cliPath; SDK runs `node index.js`.
  const candidates = [
    // Dev: relative to agent-server bundle output (dist/agent-server/<v>/index.mjs)
    path.resolve(__dirname, '..', '..', '..', 'node_modules', '@github', 'copilot', 'index.js'),
    // Dev: relative to project root (when running unbundled via tsx/ts-node)
    path.resolve(__dirname, '..', '..', 'node_modules', '@github', 'copilot', 'index.js'),
    // Packaged: app.asar.unpacked
    path.resolve(__dirname, '..', '..', 'app.asar.unpacked', 'node_modules', '@github', 'copilot', 'index.js'),
    // User global install (~/.nvm or system)
    path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@github', 'copilot', 'index.js'),
    '/usr/local/lib/node_modules/@github/copilot/index.js',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

interface CachedModel {
  id: string;
  name?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

interface CopilotState {
  client: import('@github/copilot-sdk').CopilotClient | null;
  session: import('@github/copilot-sdk').CopilotSession | null;
  /** Copilot CLI's session ID (separate from our app's sessionId). */
  cliSessionId: string | null;
  /** Cached models from last listModels() call. */
  models: CachedModel[];
}

export function createCopilotBackend(): ServerBackend {
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;
  let currentModel = DEFAULT_MODEL;
  let currentEffort: string | undefined;
  let currentPermissionMode = 'default';
  let currentSessionId: string | null = null;
  // External vocabulary (shared with Claude) → Copilot SDK SessionMode.
  const MODE_TO_SDK: Record<string, 'interactive' | 'plan' | 'autopilot'> = {
    default: 'interactive',
    bypassPermissions: 'autopilot',
    plan: 'plan',
  };
  let latestUsage: {
    currentTokens: number;
    tokenLimit: number;
    conversationTokens?: number;
    systemTokens?: number;
    toolDefinitionsTokens?: number;
    messagesLength: number;
  } | null = null;
  const state: CopilotState = { client: null, session: null, cliSessionId: null, models: [] };

  function modelMeta(id: string): CachedModel | undefined {
    return state.models.find((m) => m.id === id);
  }

  function effortsFor(modelId: string): string[] {
    return modelMeta(modelId)?.supportedReasoningEfforts ?? [];
  }

  function buildCapabilities(): ProviderCapabilities & { currentModel: string; currentEffort?: string; currentPermissionMode: string } {
    return {
      currentModel,
      currentEffort,
      currentPermissionMode,
      models: state.models.map((m) => ({
        value: m.id,
        displayName: m.name ?? m.id,
        effortLevels: (m.supportedReasoningEfforts ?? []).map((v) => ({ value: v, displayName: v })),
      })),
      // acceptEdits has no Copilot equivalent — omit it (honest capability surface).
      permissionModes: [
        { value: 'default', displayName: 'ask' },
        { value: 'bypassPermissions', displayName: 'bypassPermissions', severity: 'critical' },
        { value: 'plan', displayName: 'plan', severity: 'info' },
      ],
      effortLevels: effortsFor(currentModel).map((v) => ({ value: v, displayName: v })),
      slashCommands: SLASH_COMMANDS,
      authMethod: {
        kind: 'oauth' as const,
        instructions: [
          { label: 'Sign in via gh CLI', command: 'gh auth login -s copilot' },
        ],
      },
    };
  }

  // Permission handler: bridge Copilot SDK permission requests to our existing
  // permission_request IPC contract (UI shows Allow/Deny buttons).
  // PermissionRequest shape: { kind: "shell"|"write"|"mcp"|"read"|"url"|"custom-tool"|"memory"|"hook", toolCallId? }
  const onPermissionRequest = async (request: any) => {
    const toolUseId = request.toolCallId ?? `copilot-${Date.now()}`;
    currentSend?.({
      type: 'permission_request',
      toolUseId,
      toolName: request.kind ?? 'unknown',
      input: {},
    });
    const result = await new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(toolUseId, resolve);
    });
    return result.behavior === 'allow'
      ? { kind: 'approve-once' as const }
      : { kind: 'reject' as const, feedback: result.message };
  };

  async function ensureClient(): Promise<import('@github/copilot-sdk').CopilotClient> {
    if (state.client) return state.client;
    const { CopilotClient } = await getSdk();
    const cliPath = resolveCopilotCliPath();
    if (!cliPath) {
      throw new Error('GitHub Copilot CLI not found. Install with: npm install -g @github/copilot');
    }
    // Force gh-CLI auth path: explicit gitHubToken takes priority over keychain/plaintext,
    // so the spawned CLI never touches macOS Keychain (no scary OS prompt).
    // Mirrors how the Claude integration relies on the user's existing Claude Code login.
    const ghToken = await readGhToken();
    if (!ghToken) {
      throw new Error('GitHub Copilot 需要 gh CLI 登入。請執行：gh auth login -s copilot');
    }
    state.client = new CopilotClient({
      cliPath,
      useStdio: true,
      gitHubToken: ghToken,
      useLoggedInUser: false,
      logLevel: 'warning',
      // Suppress Node's "SQLite is experimental" warning the CLI emits on stdout/stderr.
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    await state.client.start();
    return state.client;
  }

  async function ensureSession(): Promise<import('@github/copilot-sdk').CopilotSession> {
    if (state.session) return state.session;
    const client = await ensureClient();
    const config: any = {
      model: currentModel,
      onPermissionRequest,
    };
    if (currentEffort) config.reasoningEffort = currentEffort;

    let session: import('@github/copilot-sdk').CopilotSession;
    if (state.cliSessionId) {
      try {
        session = await client.resumeSession(state.cliSessionId, config);
      } catch {
        session = await client.createSession(config);
      }
    } else {
      session = await client.createSession(config);
    }
    state.session = session;
    state.cliSessionId = session.sessionId;

    // If user already picked a non-default mode before this session existed, apply it.
    const sdkMode = MODE_TO_SDK[currentPermissionMode];
    if (sdkMode && sdkMode !== 'interactive') {
      try { await (session as any).rpc.mode.set({ mode: sdkMode }); } catch { /* ignore */ }
    }

    // Wire events to send fn. Copilot CLI's built-in tools (read_file, edit, bash, etc.)
    // are used directly; we don't register custom tools.
    session.on((event: any) => {
      if (!currentSend) return;
      switch (event.type) {
        case 'assistant.message_delta':
          if (event.data?.deltaContent) {
            currentSend({ type: 'stream', streamType: 'text', content: event.data.deltaContent });
          }
          break;
        case 'assistant.reasoning_delta':
          if (event.data?.deltaContent) {
            currentSend({ type: 'stream', streamType: 'thinking', content: event.data.deltaContent });
          }
          break;
        case 'assistant.message':
          if (event.data?.content) {
            currentSend({ type: 'message', msgType: 'text', content: event.data.content });
          }
          break;
        case 'assistant.reasoning':
          if (event.data?.content) {
            currentSend({ type: 'message', msgType: 'thinking', content: event.data.content });
          }
          break;
        case 'tool.execution_start':
          currentSend({
            type: 'message', msgType: 'tool_use', content: '',
            toolName: event.data?.toolName ?? 'unknown',
            toolInput: event.data?.arguments ?? {},
            toolUseId: event.data?.toolCallId ?? '',
          });
          break;
        case 'tool.execution_complete': {
          const data = event.data ?? {};
          const text = data.success === false
            ? `Error: ${data.error?.message ?? 'tool failed'}`
            : (data.result?.detailedContent ?? data.result?.content ?? '');
          currentSend({
            type: 'message', msgType: 'tool_result',
            content: text.slice(0, 8000),
            toolUseId: data.toolCallId ?? '',
          });
          break;
        }
        case 'assistant.usage': {
          const quotaSnapshots = event.data?.quotaSnapshots as Record<string, any> | undefined;
          const rateLimits: StatusSegment[] = [];
          if (quotaSnapshots) {
            for (const [key, snap] of Object.entries(quotaSnapshots)) {
              if (snap?.isUnlimitedEntitlement) continue;
              if (typeof snap?.remainingPercentage !== 'number') continue;
              // No clamp: GitHub shows actual usage including overage (e.g. 120%).
              const u = Math.max(0, 1 - snap.remainingPercentage);
              const label = COPILOT_QUOTA_LABELS[key] ?? key;
              const pct = Math.round(u * 100);
              const reset = snap.resetDate ? formatResetCountdown(Date.parse(snap.resetDate)) : null;
              const severity = snap.usageAllowedWithExhaustedQuota === false && u >= 1
                ? 'critical'
                : severityFromUtilization(u);
              rateLimits.push({
                text: `${label}: ${pct}%${reset ? ` ↻${reset}` : ''}`,
                severity,
              });
            }
          }
          currentSend({
            type: 'status', state: 'streaming',
            model: currentModel,
            inputTokens: event.data?.inputTokens,
            outputTokens: event.data?.outputTokens,
            ...(rateLimits.length > 0 ? { rateLimits } : {}),
          });
          break;
        }
        case 'session.usage_info': {
          const cur = event.data?.currentTokens ?? 0;
          const limit = event.data?.tokenLimit ?? 0;
          latestUsage = {
            currentTokens: cur,
            tokenLimit: limit,
            conversationTokens: event.data?.conversationTokens,
            systemTokens: event.data?.systemTokens,
            toolDefinitionsTokens: event.data?.toolDefinitionsTokens,
            messagesLength: event.data?.messagesLength ?? 0,
          };
          if (limit > 0) {
            const ratio = cur / limit;
            currentSend({
              type: 'status', state: 'streaming',
              contextUsage: {
                text: `ctx: ${Math.round(ratio * 100)}%`,
                severity: severityFromUtilization(ratio),
              },
            });
          }
          break;
        }
        case 'session.plan_changed':
          // Debounced fetch — multiple rapid changes coalesce into one read.
          schedulePlanRead();
          break;
        case 'session.error':
        case 'model.call_failure': {
          const msg = event.data?.message ?? event.data?.error ?? 'Unknown error';
          currentSend({ type: 'error', error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
          break;
        }
      }
    });
    return session;
  }

  let planReadTimer: NodeJS.Timeout | null = null;
  function schedulePlanRead() {
    if (planReadTimer) return;
    planReadTimer = setTimeout(async () => {
      planReadTimer = null;
      if (!state.session || !currentSend) return;
      try {
        const result = await (state.session as any).rpc.plan.read();
        currentSend({
          type: 'message',
          msgType: 'plan_update',
          content: result?.exists ? (result.content ?? '') : '',
        });
      } catch { /* ignore */ }
    }, 150);
  }

  async function listModelsCached(): Promise<CachedModel[]> {
    const client = await ensureClient();
    const list = await client.listModels();
    state.models = list.map((m: any) => ({
      id: m.id ?? m.name ?? String(m),
      name: m.name ?? m.id,
      supportedReasoningEfforts: m.supportedReasoningEfforts,
      defaultReasoningEffort: m.defaultReasoningEffort,
    }));
    return state.models;
  }

  return {
    async gatherCapabilities(_cwd: string, sessionId?: string): Promise<ProviderCapabilities> {
      if (sessionId) currentSessionId = sessionId;
      await listModelsCached();
      if (!currentEffort) currentEffort = modelMeta(currentModel)?.defaultReasoningEffort;
      return buildCapabilities();
    },

    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      const modelChanged = !!(input.model && input.model !== currentModel);
      if (modelChanged) {
        currentModel = input.model!;
        // Reset effort to new model's default if previous effort isn't supported.
        const supported = effortsFor(currentModel);
        if (currentEffort && !supported.includes(currentEffort)) {
          currentEffort = modelMeta(currentModel)?.defaultReasoningEffort;
        } else if (!currentEffort) {
          currentEffort = modelMeta(currentModel)?.defaultReasoningEffort;
        }
      }
      if (input.effort && input.effort !== currentEffort) {
        currentEffort = input.effort;
      }
      const modeChanged = !!(input.permissionMode && input.permissionMode !== currentPermissionMode);
      if (modeChanged) currentPermissionMode = input.permissionMode!;
      if (state.session && (modelChanged || input.effort)) {
        try {
          await state.session.setModel(currentModel, currentEffort ? { reasoningEffort: currentEffort as any } : undefined);
        } catch (err: any) {
          send({ type: 'error', error: `Failed to switch model: ${err.message}` });
        }
      }
      if (state.session && modeChanged) {
        const sdkMode = MODE_TO_SDK[currentPermissionMode];
        if (sdkMode) {
          try {
            await (state.session as any).rpc.mode.set({ mode: sdkMode });
          } catch (err: any) {
            send({ type: 'error', error: `Failed to switch mode: ${err.message}` });
          }
        }
      }
      if (modelChanged) send({ type: 'capabilities', ...buildCapabilities() });
      if (input.sessionId) currentSessionId = input.sessionId;

      send({ type: 'status', state: 'streaming', model: currentModel });

      try {
        const session = await ensureSession();
        await session.sendAndWait({ prompt: input.prompt });
        send({ type: 'status', state: 'idle', model: currentModel });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes('not authenticated') || msg.includes('auth')) {
          send({ type: 'auth_required', provider: 'copilot' });
        } else {
          send({ type: 'error', error: `Copilot error: ${msg}` });
        }
        send({ type: 'status', state: 'idle' });
      }
    },

    async stop() {
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
      try { await state.session?.abort(); } catch { /* ignore */ }
    },

    dispose() {
      try { state.session?.disconnect(); } catch { /* ignore */ }
      try { state.client?.stop(); } catch { /* ignore */ }
      state.session = null;
      state.client = null;
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
          const models = await listModelsCached();
          const list = models.map((m) => ({ value: m.id, displayName: m.name ?? m.id }));
          if (!arg) return { type: 'show-model-picker', models: list, current: currentModel };
          const match = list.find((m) => m.value === arg);
          if (!match) return { type: 'error', message: `Unknown model: ${arg}` };
          currentModel = arg;
          const supported = effortsFor(currentModel);
          if (!currentEffort || !supported.includes(currentEffort)) {
            currentEffort = modelMeta(currentModel)?.defaultReasoningEffort;
          }
          if (state.session) {
            try {
              await state.session.setModel(currentModel, currentEffort ? { reasoningEffort: currentEffort as any } : undefined);
            } catch { /* SDK will retry on next send */ }
          }
          currentSend?.({ type: 'capabilities', ...buildCapabilities() });
          return { type: 'switch-model', model: arg };
        }

        case 'context': {
          if (!latestUsage) {
            return { type: 'system-message', content: 'No context info yet. Send a message first.' };
          }
          const u = latestUsage;
          const pct = u.tokenLimit > 0 ? Math.round((u.currentTokens / u.tokenLimit) * 100) : 0;
          const fmt = (n?: number) => n != null ? n.toLocaleString() : '-';
          const lines = [
            `Context: ${fmt(u.currentTokens)} / ${fmt(u.tokenLimit)} tokens (${pct}%)`,
            `Messages: ${u.messagesLength}`,
            `  - Conversation: ${fmt(u.conversationTokens)}`,
            `  - System: ${fmt(u.systemTokens)}`,
            `  - Tools: ${fmt(u.toolDefinitionsTokens)}`,
          ];
          return { type: 'system-message', content: lines.join('\n') };
        }

        case 'compact': {
          if (!state.session) {
            return { type: 'system-message', content: 'No active session to compact.' };
          }
          try {
            const result = await (state.session as any).rpc.history.compact();
            if (!result?.success) {
              return { type: 'error', message: 'Compaction failed' };
            }
            const removed = result.tokensRemoved?.toLocaleString() ?? '?';
            const msgs = result.messagesRemoved ?? 0;
            return { type: 'system-message', content: `Compacted: freed ${removed} tokens across ${msgs} messages.` };
          } catch (err: any) {
            return { type: 'error', message: `Compact failed: ${err?.message ?? err}` };
          }
        }

        case 'clear': {
          // Drop session — next query creates a fresh one.
          try { await state.session?.disconnect(); } catch { /* ignore */ }
          state.session = null;
          state.cliSessionId = null;
          latestUsage = null;
          currentSend?.({ type: 'message', msgType: 'plan_update', content: '' });
          return { type: 'context-cleared', message: 'Context cleared' };
        }

        case 'help': {
          const lines = SLASH_COMMANDS.map((c) => `- /${c.name} — ${c.description}`).join('\n');
          return { type: 'system-message', content: `Available commands:\n${lines}` };
        }

        default:
          return { type: 'error', message: `Unknown command: /${cmd}` };
      }
    },
  };
}
