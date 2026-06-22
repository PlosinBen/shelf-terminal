/**
 * Decides whether the panel can emit task cards LIVE (as task_started arrives)
 * instead of batching them at the foreground turn's close.
 *
 * The batch-at-close design (#69) existed to avoid spurious cards for SYNC
 * (foreground, non-backgrounded) Bash — IF a sync Bash also emits a
 * `system/task_started`, emitting live would show a card for every foreground
 * shell call. This probe runs ONE sync bash + ONE run_in_background bash in the
 * same turn and dumps which produce task_started.
 *
 *   - sync bash emits task_started  → live emission is UNSAFE (keep batching)
 *   - only the background one does   → live emission is SAFE (fix the UX)
 *
 * Run: npx tsx scripts/spike-sync-vs-bg.ts
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

// tool_use_id → { command, run_in_background } so we can attribute task_started.
const toolUses = new Map<string, { cmd: string; bg: boolean }>();
const startedByToolUse = new Set<string>();

function dump(m: SDKMessage) {
  const any = m as any;
  if (m.type === 'system' && typeof any.subtype === 'string' && any.subtype.startsWith('task_')) {
    if (any.subtype === 'task_started' && typeof any.tool_use_id === 'string') startedByToolUse.add(any.tool_use_id);
    // Dump the FULL task_ message so we can see task_type / description / any
    // field that distinguishes a sync from a background task at task_started time.
    console.log(`  ⟪SYSTEM ${any.subtype}⟫`, JSON.stringify(any));
  } else if (m.type === 'assistant') {
    for (const b of (m.message.content as any[])) {
      if (b.type === 'tool_use' && b.name === 'Bash') {
        const bg = b.input?.run_in_background === true;
        toolUses.set(b.id, { cmd: String(b.input?.command ?? '').slice(0, 40), bg });
        console.log(`  Bash tool_use id=${b.id} run_in_background=${bg} cmd=${JSON.stringify(b.input?.command)}`);
      } else if (b.type === 'text') {
        console.log(`  assistant.text: ${b.text.slice(0, 60).replace(/\n/g, ' ')}`);
      }
    }
  } else if (m.type === 'result') {
    console.log(`  result subtype=${any.subtype} origin=${any.origin?.kind ?? '·'}`);
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

  const PROMPT =
    'Run TWO Bash commands in this one turn: ' +
    '(1) a NORMAL foreground command `sleep 4 && echo SYNC_HELLO` (run_in_background=false) and WAIT for its result; ' +
    '(2) a background command `sleep 6 && echo BG_BYE` with run_in_background=true (do not wait). ' +
    'Then reply "both issued".';
  console.log('--- spike-sync-vs-bg ---\n');
  input.push(PROMPT);

  const drain = (async () => { for await (const m of q) dump(m); })();
  await sleep(20_000);
  input.close();
  await Promise.race([drain, sleep(1000)]);

  console.log('\n--- ATTRIBUTION ---');
  for (const [id, info] of toolUses) {
    console.log(`  ${info.bg ? 'BACKGROUND' : 'SYNC      '} cmd=${JSON.stringify(info.cmd)} → task_started: ${startedByToolUse.has(id) ? 'YES' : 'no'}`);
  }
  const syncEmitted = [...toolUses].some(([id, i]) => !i.bg && startedByToolUse.has(id));
  const bgEmitted = [...toolUses].some(([id, i]) => i.bg && startedByToolUse.has(id));
  console.log('\n--- VERDICT ---');
  if (syncEmitted) console.log('⚠️  SYNC bash ALSO emits task_started → live emission UNSAFE (keep batch-at-close).');
  else if (bgEmitted) console.log('✅ Only the BACKGROUND bash emits task_started → live emission SAFE (panel can update live).');
  else console.log('ℹ️  No task_started captured — inspect dump above.');
  process.exit(0);
}
main().catch((e) => { console.error('spike error:', e); process.exit(1); });
