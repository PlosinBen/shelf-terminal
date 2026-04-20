import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as readline from 'readline';
import * as path from 'path';

interface IncomingMessage {
  type: 'send' | 'stop' | 'ping';
  prompt?: string;
  cwd?: string;
  resume?: string;
  permissionMode?: string;
}

interface OutgoingMessage {
  type: 'message' | 'stream' | 'status' | 'error' | 'pong' | 'ready';
  [key: string]: unknown;
}

function send(msg: OutgoingMessage) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let activeQuery: Query | null = null;
let abortController: AbortController | null = null;

async function handleSend(msg: IncomingMessage) {
  if (!msg.prompt || !msg.cwd) {
    send({ type: 'error', error: 'Missing prompt or cwd' });
    return;
  }

  abortController = new AbortController();

  const cliPath = path.join(__dirname, 'cli.js');

  const options: Options = {
    abortController,
    cwd: msg.cwd,
    pathToClaudeCodeExecutable: cliPath,
    tools: { type: 'preset', preset: 'claude_code' },
    thinking: { type: 'adaptive' },
    includePartialMessages: true,
    permissionMode: (msg.permissionMode as Options['permissionMode']) ?? 'default',
  };

  if (msg.resume) {
    options.resume = msg.resume;
  }

  activeQuery = sdkQuery({ prompt: msg.prompt, options });

  try {
    for await (const sdkMsg of activeQuery) {
      processMessage(sdkMsg);
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      send({ type: 'error', error: err.message ?? 'Unknown error' });
    }
  } finally {
    activeQuery = null;
    abortController = null;
    send({ type: 'status', state: 'idle' });
  }
}

function processMessage(msg: SDKMessage) {
  switch (msg.type) {
    case 'assistant': {
      for (const block of msg.message.content) {
        if (block.type === 'thinking') {
          send({ type: 'message', msgType: 'thinking', content: block.thinking, sessionId: msg.session_id });
        } else if (block.type === 'text') {
          send({ type: 'message', msgType: 'text', content: block.text, sessionId: msg.session_id });
        } else if (block.type === 'tool_use') {
          send({
            type: 'message', msgType: 'tool_use', content: '',
            toolName: block.name, toolInput: block.input, toolUseId: block.id,
            parentToolUseId: msg.parent_tool_use_id ?? undefined, sessionId: msg.session_id,
          });
        }
      }
      if (msg.message.usage) {
        send({
          type: 'status', state: 'streaming', model: msg.message.model,
          inputTokens: msg.message.usage.input_tokens, outputTokens: msg.message.usage.output_tokens,
          sessionId: msg.session_id,
        });
      }
      break;
    }

    case 'user': {
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if ((block as any).type === 'tool_result') {
            send({
              type: 'message', msgType: 'tool_result',
              content: typeof (block as any).content === 'string' ? (block as any).content : JSON.stringify((block as any).content ?? ''),
              toolUseId: (block as any).tool_use_id, sessionId: msg.session_id,
            });
          }
        }
      }
      break;
    }

    case 'result': {
      const isSuccess = msg.subtype === 'success';
      send({
        type: 'message', msgType: 'result',
        content: isSuccess ? msg.result : (msg.errors?.join('\n') ?? 'Error'),
        sessionId: msg.session_id,
        costUsd: isSuccess ? msg.total_cost_usd : undefined,
        inputTokens: isSuccess ? msg.usage?.input_tokens : undefined,
        outputTokens: isSuccess ? msg.usage?.output_tokens : undefined,
      });
      send({
        type: 'status', state: 'idle',
        costUsd: isSuccess ? msg.total_cost_usd : undefined,
        inputTokens: isSuccess ? msg.usage?.input_tokens : undefined,
        outputTokens: isSuccess ? msg.usage?.output_tokens : undefined,
        numTurns: isSuccess ? msg.num_turns : undefined,
        sessionId: msg.session_id,
      });
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        send({ type: 'message', msgType: 'system', content: `Model: ${msg.model}`, sessionId: msg.session_id });
        send({ type: 'status', state: 'streaming', model: msg.model, sessionId: msg.session_id });
      }
      break;
    }
  }
}

async function handleStop() {
  if (activeQuery) {
    try {
      await activeQuery.interrupt();
    } catch {
      abortController?.abort();
    }
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
  abortController?.abort();
  process.exit(0);
});

send({ type: 'ready' });
