import * as readline from 'readline';
import { createClaudeBackend } from './providers/claude';
import { createCopilotBackend } from './providers/copilot';
import { deleteContext } from './context-store';
import type { OutgoingMessage, QueryInput, ServerBackend } from './providers/types';

type Provider = 'claude' | 'copilot';

interface IncomingMessage {
  type: 'send' | 'stop' | 'ping' | 'resolve_permission' | 'get_capabilities' | 'store_credential' | 'clear_credential' | 'clear_context';
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

  const input: QueryInput = {
    prompt: msg.prompt,
    cwd: msg.cwd,
    resume: msg.resume,
    permissionMode: msg.permissionMode,
    model: msg.model,
    effort: msg.effort,
    images: msg.images,
    sessionId: msg.sessionId,
  };
  await backend.query(input, send);
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
        activeBackend.resolvePermission?.(msg.toolUseId, msg.allow ?? false, msg.message);
      }
      break;
    case 'get_capabilities': {
      const provider = msg.provider ?? 'claude';
      (async () => {
        try {
          const backend = getBackend(provider);
          const caps = await backend.gatherCapabilities?.(msg.cwd ?? process.cwd());
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
      if (msg.sessionId) deleteContext(msg.sessionId);
      break;
    }
  }
});

rl.on('close', () => {
  for (const b of backends.values()) b.dispose();
  process.exit(0);
});

send({ type: 'ready' });
