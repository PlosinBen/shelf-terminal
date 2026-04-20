import * as readline from 'readline';
import { createClaudeBackend } from './providers/claude';
import type { OutgoingMessage, QueryInput, ServerBackend } from './providers/types';

type Provider = 'claude' | 'copilot' | 'gemini';

interface IncomingMessage {
  type: 'send' | 'stop' | 'ping';
  provider?: Provider;
  prompt?: string;
  cwd?: string;
  resume?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  images?: string[];
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
    case 'gemini':
      throw new Error(`Provider ${provider} not yet implemented in agent-server`);
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
  }
});

rl.on('close', () => {
  for (const b of backends.values()) b.dispose();
  process.exit(0);
});

send({ type: 'ready' });
