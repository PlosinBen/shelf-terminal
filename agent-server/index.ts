import * as readline from 'readline';
import { createClaudeBackend } from './providers/claude';
import { createCopilotBackend } from './providers/copilot';
import { deleteContext, cleanupOldContexts } from './context-store';
import { loadRestoreContextFor, wrapSendForContext } from './orchestrator';
import type { OutgoingMessage, QueryInput, ServerBackend } from './providers/types';
import type { ProviderModel } from '../src/shared/types';

type Provider = 'claude' | 'copilot';

interface IncomingMessage {
  type: 'send' | 'stop' | 'ping' | 'resolve_permission' | 'get_capabilities' | 'store_credential' | 'clear_credential' | 'clear_context' | 'slash_command';
  provider?: Provider;
  prompt?: string;
  cwd?: string;
  resume?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  images?: string[];
  sessionId?: string;
  toolUseId?: string;
  allow?: boolean;
  message?: string;
  requestId?: string;
  key?: string;
  cmd?: string;
  args?: string;
  customModels?: ProviderModel[];
  scope?: 'once' | 'session';
}

function send(msg: OutgoingMessage) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const backends = new Map<Provider, ServerBackend>();
let activeBackend: ServerBackend | null = null;

function getBackend(provider: Provider): ServerBackend {
  let b = backends.get(provider);
  if (b) return b;
  switch (provider) {
    case 'claude':
      b = createClaudeBackend();
      break;
    case 'copilot':
      b = createCopilotBackend();
      break;
  }
  backends.set(provider, b);
  return b;
}

async function handleSend(msg: IncomingMessage) {
  if (!msg.prompt || !msg.cwd) {
    send({ type: 'error', error: 'Missing prompt or cwd' });
    return;
  }
  const provider = msg.provider ?? 'claude';
  let backend: ServerBackend;
  try {
    backend = getBackend(provider);
  } catch (err: any) {
    send({ type: 'error', error: err.message });
    return;
  }
  activeBackend = backend;

  // Hydrate persisted context once per turn — providers read fields they care
  // about (e.g. `lastSdkSessionId`) without touching disk themselves.
  const restoreContext = loadRestoreContextFor(provider, msg.sessionId);

  const input: QueryInput = {
    prompt: msg.prompt,
    cwd: msg.cwd,
    resume: msg.resume,
    permissionMode: msg.permissionMode,
    model: msg.model,
    effort: msg.effort,
    images: msg.images,
    sessionId: msg.sessionId,
    restoreContext,
  };
  await backend.query(input, wrapSendForContext(provider, msg.sessionId, send));
}

async function handleStop() {
  if (activeBackend) {
    await activeBackend.stop();
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  let msg: IncomingMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: 'error', error: 'Invalid JSON' });
    return;
  }

  switch (msg.type) {
    case 'send':
      handleSend(msg);
      break;
    case 'stop':
      handleStop();
      break;
    case 'ping':
      send({ type: 'pong' });
      break;
    case 'resolve_permission':
      if (activeBackend && msg.toolUseId !== undefined) {
        activeBackend.resolvePermission?.(msg.toolUseId, msg.allow ?? false, msg.message, msg.scope);
      }
      break;
    case 'get_capabilities': {
      const provider = msg.provider ?? 'claude';
      (async () => {
        try {
          const backend = getBackend(provider);
          const caps = await backend.gatherCapabilities?.(msg.cwd ?? process.cwd(), msg.sessionId, msg.customModels);
          send({ type: 'capabilities', requestId: msg.requestId, ...(caps ?? {}) });
        } catch (err: any) {
          send({ type: 'capabilities', requestId: msg.requestId, error: err?.message ?? String(err) });
        }
      })();
      break;
    }
    case 'store_credential': {
      const provider = msg.provider ?? 'claude';
      (async () => {
        try {
          const backend = getBackend(provider);
          if (!backend.storeCredential) throw new Error(`Provider ${provider} does not accept API keys`);
          await backend.storeCredential(msg.key ?? '');
          send({ type: 'credential_stored', requestId: msg.requestId, ok: true });
        } catch (err: any) {
          send({ type: 'credential_stored', requestId: msg.requestId, ok: false, error: err?.message ?? String(err) });
        }
      })();
      break;
    }
    case 'clear_credential': {
      const provider = msg.provider ?? 'claude';
      (async () => {
        try {
          const backend = getBackend(provider);
          if (!backend.clearCredential) throw new Error(`Provider ${provider} has no credential to clear`);
          await backend.clearCredential();
          send({ type: 'credential_cleared', requestId: msg.requestId, ok: true });
        } catch (err: any) {
          send({ type: 'credential_cleared', requestId: msg.requestId, ok: false, error: err?.message ?? String(err) });
        }
      })();
      break;
    }
    case 'clear_context': {
      if (msg.sessionId) {
        deleteContext(msg.sessionId);
        // Tell every provider that has cached state for this session to drop it,
        // so they don't try to resume from a now-deleted lastSdkSessionId on
        // the next turn. Sync per-backend call — they just clear in-memory refs.
        for (const b of backends.values()) b.resetSession?.(msg.sessionId);
      }
      break;
    }
    case 'slash_command': {
      const provider = msg.provider ?? 'claude';
      (async () => {
        try {
          const backend = getBackend(provider);
          if (!backend.handleSlashCommand) {
            send({ type: 'slash_result', requestId: msg.requestId, result: { type: 'pass-through' } });
            return;
          }
          const result = await backend.handleSlashCommand(msg.cmd ?? '', msg.args ?? '');
          // Provider's `/clear` only clears its own in-memory state. Mirror it
          // to disk here so the next process restart doesn't resurrect the
          // just-cleared session via `restoreContext`.
          if (result.type === 'context-cleared' && msg.sessionId) {
            deleteContext(msg.sessionId);
          }
          send({ type: 'slash_result', requestId: msg.requestId, result });
        } catch (err: any) {
          send({ type: 'slash_result', requestId: msg.requestId, result: { type: 'error', message: err?.message ?? String(err) } });
        }
      })();
      break;
    }
  }
});

rl.on('close', () => {
  for (const b of backends.values()) b.dispose();
  process.exit(0);
});

cleanupOldContexts();
send({ type: 'ready' });
