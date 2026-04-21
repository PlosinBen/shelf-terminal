import * as readline from 'readline';
import { createClaudeBackend } from './providers/claude';
import { createCopilotBackend } from './providers/copilot';
import { createGeminiBackend } from './providers/gemini';
import type { OutgoingMessage, QueryInput, ServerBackend } from './providers/types';

type Provider = 'claude' | 'copilot' | 'gemini';

interface IncomingMessage {
  type: 'send' | 'stop' | 'ping' | 'resolve_permission' | 'get_capabilities';
  provider?: Provider;
  prompt?: string;
  cwd?: string;
  resume?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  images?: string[];
  // resolve_permission fields
  toolUseId?: string;
  allow?: boolean;
  message?: string;
  // get_capabilities fields
  requestId?: string;
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
    case 'gemini':
      b = createGeminiBackend();
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
        const resolver = (activeBackend as any).resolvePermission as (id: string, allow: boolean, message?: string) => void;
        resolver?.call(activeBackend, msg.toolUseId, msg.allow ?? false, msg.message);
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
  }
});

rl.on('close', () => {
  for (const b of backends.values()) b.dispose();
  process.exit(0);
});

send({ type: 'ready' });
