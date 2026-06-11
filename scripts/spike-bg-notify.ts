/**
 * Investigation: when N shell commands are launched with `run_in_background`
 * in ONE turn, does claude's SDK emit N distinct `system/task_started` (each
 * with its own `task_id`), or do they collapse (only one task_started / a
 * reused task_id)? This decides whether Shelf's panel SHOULD show N cards.
 * Raw SDK (streaming-input), no Shelf provider in the way.
 *
 * It dumps EVERY message with the fields we key on:
 *   - assistant.tool_use   → name + run_in_background flag + tool_use_id
 *   - user.tool_result     → is_error + text (the "running in background…" line)
 *   - system/task_*        → subtype + task_id + tool_use_id + status + task_type
 * and at the end tallies: distinct task_ids, task_started count, and the
 * task_id↔tool_use_id mapping so a collision (many tool_use_ids → one task_id)
 * is obvious.
 *
 * Run: npx tsx scripts/spike-bg-notify.ts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const N = 5; // how many background commands to launch in one turn

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

// Tallies for the verdict.
const taskStartedIds: string[] = [];               // task_id per task_started (dups reveal collision)
const allTaskIds = new Set<string>();               // distinct task_ids across ALL task_* events
const idToToolUse = new Map<string, Set<string>>(); // task_id → tool_use_ids that mapped to it
const bgToolUseIds = new Set<string>();             // tool_use_ids the model launched as run_in_background

function note(taskId: string | undefined, toolUseId: string | undefined) {
  if (typeof taskId !== 'string' || !taskId) return;
  allTaskIds.add(taskId);
  if (typeof toolUseId === 'string' && toolUseId) {
    if (!idToToolUse.has(taskId)) idToToolUse.set(taskId, new Set());
    idToToolUse.get(taskId)!.add(toolUseId);
  }
}

function dump(m: SDKMessage) {
  const any = m as any;
  if (m.type === 'system') {
    const sub = any.subtype;
    if (typeof sub === 'string' && sub.startsWith('task_')) {
      if (sub === 'task_started') taskStartedIds.push(String(any.task_id));
      note(any.task_id, any.tool_use_id);
      console.log(`  ⟪SYSTEM ${sub}⟫`, JSON.stringify({ task_id: any.task_id, tool_use_id: any.tool_use_id, status: any.status, task_type: any.task_type }));
    } else {
      console.log(`  system/${sub}`);
    }
  } else if (m.type === 'assistant') {
    for (const b of (m.message.content as any[])) {
      if (b.type === 'text') console.log(`  assistant.text: ${b.text.slice(0, 70).replace(/\n/g, ' ')}`);
      else if (b.type === 'tool_use') {
        const bg = b.input?.run_in_background === true;
        if (bg) bgToolUseIds.add(b.id);
        console.log(`  assistant.tool_use ${b.name} id=${b.id} run_in_background=${bg} input=${JSON.stringify(b.input).slice(0, 120)}`);
      }
    }
  } else if (m.type === 'user') {
    const c: any = (m as any).message?.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'tool_result') console.log(`  user.tool_result(tool_use_id=${b.tool_use_id}, is_error=${b.is_error}): ${JSON.stringify(b.content).slice(0, 160)}`);
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

  const PROMPT =
    `Launch ${N} separate shell commands, EACH with run_in_background (do not wait for any): ` +
    Array.from({ length: N }, (_, i) => `\`sleep ${5 + i * 2} && echo BG${i + 1}_DONE\``).join(', ') +
    `. Run them as ${N} distinct background Bash tool calls, then immediately reply "launched ${N}".`;
  console.log('--- spike-bg-notify (multi) ---\nprompt:', PROMPT, '\n');
  input.push(PROMPT);

  // Drain + dump for ~40s so the longest (sleep ~13s) settles and any delayed
  // notifications land.
  const drain = (async () => { for await (const m of q) dump(m); })();
  await sleep(40_000);
  input.close();
  await Promise.race([drain, sleep(1000)]);

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log('\n--- TALLY ---');
  console.log(`run_in_background tool_use launched : ${bgToolUseIds.size}`);
  console.log(`task_started events                 : ${taskStartedIds.length}  ids=${JSON.stringify(taskStartedIds)}`);
  console.log(`distinct task_ids (all task_* msgs) : ${allTaskIds.size}  ${JSON.stringify([...allTaskIds])}`);
  console.log('task_id → tool_use_ids mapping:');
  for (const [tid, uses] of idToToolUse) console.log(`  ${tid} ← ${JSON.stringify([...uses])}`);

  const collision = [...idToToolUse.values()].some((s) => s.size > 1);
  const startedDup = new Set(taskStartedIds).size < taskStartedIds.length;
  console.log('\n--- VERDICT ---');
  if (bgToolUseIds.size >= 2 && allTaskIds.size <= 1) console.log('⚠️  N background launches but ≤1 task_id — events COLLAPSED (only one task surfaced).');
  else if (collision || startedDup) console.log('⚠️  task_id REUSED across distinct background launches — Map would overwrite to one card.');
  else if (allTaskIds.size >= bgToolUseIds.size && bgToolUseIds.size >= 2) console.log(`✅ ${allTaskIds.size} distinct task_ids for ${bgToolUseIds.size} launches — panel SHOULD show ${allTaskIds.size} cards.`);
  else console.log(`ℹ️  launches=${bgToolUseIds.size}, distinct task_ids=${allTaskIds.size} — inspect dump above.`);
  process.exit(0);
}
main().catch((e) => { console.error('spike error:', e); process.exit(1); });
