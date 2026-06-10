/**
 * Investigation: when does claude's SDK emit a `system/task_started` (the signal
 * our panel + stop-task rely on) vs only return a "Command running in background
 * with ID: …" tool-result? Raw SDK (streaming-input), no Shelf provider in the
 * way. Dumps EVERY message — for `user` we print the tool_result text, for
 * `system` the full object — and keeps draining ~25s after the prompt so any
 * delayed task_started/notification is captured.
 *
 * Run: npx tsx scripts/spike-bg-notify.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

function createInput() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      if (queue.length) { yield queue.shift()!; continue; }
      await new Promise<void>((r) => { wake = r; });
    }
  }
  return {
    stream: stream(),
    push(t: string) { queue.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null }); wake?.(); wake = null; },
    close() { closed = true; wake?.(); wake = null; },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let sawTaskStarted = false;

function dump(m: SDKMessage) {
  const any = m as any;
  if (m.type === 'system') {
    const sub = any.subtype;
    if (typeof sub === 'string' && sub.startsWith('task_')) {
      sawTaskStarted = sawTaskStarted || sub === 'task_started';
      console.log(`  ⟪SYSTEM ${sub}⟫`, JSON.stringify({ task_id: any.task_id, tool_use_id: any.tool_use_id, status: any.status, task_type: any.task_type }));
    } else {
      console.log(`  system/${sub}`);
    }
  } else if (m.type === 'assistant') {
    for (const b of (m.message.content as any[])) {
      if (b.type === 'text') console.log(`  assistant.text: ${b.text.slice(0, 70).replace(/\n/g, ' ')}`);
      else if (b.type === 'tool_use') console.log(`  assistant.tool_use ${b.name} input=${JSON.stringify(b.input).slice(0, 140)}`);
    }
  } else if (m.type === 'user') {
    const c: any = (m as any).message?.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'tool_result') console.log(`  user.tool_result(is_error=${b.is_error}): ${JSON.stringify(b.content).slice(0, 160)}`);
    }
  } else if (m.type === 'result') {
    console.log(`  result subtype=${any.subtype} origin=${any.origin?.kind ?? '·'}`);
  } else {
    console.log(`  ${m.type}`);
  }
}

async function main() {
  const input = createInput();
  const q = query({
    prompt: input.stream,
    options: {
      tools: { type: 'preset', preset: 'claude_code' } as any,
      canUseTool: async (_n: string, i: any) => ({ behavior: 'allow' as const, updatedInput: i }),
    },
  }) as Query;

  const PROMPT = 'Run this shell command IN THE BACKGROUND (run_in_background): `sleep 30 && echo BG_DONE`. Immediately reply "started" without waiting for it.';
  console.log('--- spike-bg-notify ---\nprompt:', PROMPT, '\n');
  input.push(PROMPT);

  // Drain in the background, dump everything, for ~25s.
  const drain = (async () => { for await (const m of q) dump(m); })();
  await sleep(25_000);
  input.close();
  await Promise.race([drain, sleep(1000)]);

  console.log(`\n--- result: task_started ${sawTaskStarted ? 'WAS' : 'was NOT'} emitted ---`);
  process.exit(0);
}
main().catch((e) => { console.error('spike error:', e); process.exit(1); });
