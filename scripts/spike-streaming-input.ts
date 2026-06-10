/**
 * Spike: Architecture B — claude streaming-input 持久 session 行為釘死。
 *
 * 目的：在 commit 任何重構前，真機確認 streaming-input 模式的四個關鍵行為，
 *       決定 FIFO turnId 對應策略是否成立。全過才往下做重寫。
 *
 * Run: npx tsx scripts/spike-streaming-input.ts [--only=1|2|3|4]
 *      （需本機 claude 已登入；exp3/exp4 各約 ~20s）
 *
 * 四個待驗（對應 .agent/features/streaming-input-session.md §5 Phase 0）：
 *   1. session 跨 turn 存活：push A → result；不重開 query push B → 同一 session
 *      得回覆（context 延續、session_id 相同）。
 *   2. FIFO 對應：A、B 的 foreground result 的 origin.kind 與抵達順序，能否「pop
 *      front」正確對回。記錄 result 是否帶任何指回 user message 的關聯欄位。
 *   3. 背景任務中 push 新訊息的交織：A 觸發 run_in_background → A 前景 result
 *      (origin human) → 趁未 settle push B → 觀察 B 前景 vs A task-notification
 *      auto-resume 在同一 generator 上的交織順序與 origin，確認可區分、B 不被吞。
 *   4. interrupt() 語意：turn 進行中 interrupt() → 只中斷當前 turn、session 存活、
 *      可續 push。
 * 順帶：setModel()/setPermissionMode() mid-session 是否即時生效；effort 怎麼套。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? Number(onlyArg.split('=')[1]) : 0; // 0 = all

function userMsg(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/** A pushable async-iterable input stream for streaming-input mode. */
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
    push(text: string) { queue.push(userMsg(text)); wake?.(); wake = null; },
    close() { closed = true; wake?.(); wake = null; },
  };
}

/** Compact one-line log of any SDK message's identity-relevant fields. */
function logMsg(tag: string, m: SDKMessage) {
  const any = m as any;
  const origin = any.origin?.kind ?? '·';
  const base = `[${tag}] type=${m.type} origin=${origin} sid=${any.session_id?.slice(0, 8) ?? '·'} uuid=${any.uuid?.slice(0, 8) ?? '·'}`;
  if (m.type === 'assistant') {
    const txt = (m.message.content.find((b: any) => b.type === 'text') as any)?.text;
    const tools = m.message.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.name);
    console.log(`${base} text="${(txt ?? '').slice(0, 80).replace(/\n/g, ' ')}"${tools.length ? ` tools=[${tools}]` : ''}`);
  } else if (m.type === 'result') {
    // Dump the WHOLE result envelope keys once — we want to see if ANY field
    // back-references the originating user message (the §3 hard risk).
    console.log(`${base} subtype=${any.subtype} keys=[${Object.keys(any).join(',')}]`);
  } else if (m.type === 'system') {
    console.log(`${base} subtype=${any.subtype}`);
  } else if (m.type === 'user') {
    const tr = Array.isArray(any.message?.content) ? any.message.content.find((b: any) => b.type === 'tool_result') : null;
    console.log(`${base}${tr ? ` tool_result(is_error=${tr.is_error})` : ''}`);
  } else {
    console.log(base);
  }
}

/** Run a consume loop over a Query, invoking onResult when a foreground result lands. */
function consume(q: Query, tag: string, onForegroundResult: () => void, onTaskNote?: (m: any) => void) {
  return (async () => {
    for await (const m of q) {
      logMsg(tag, m);
      const any = m as any;
      if (m.type === 'result') {
        if (any.origin?.kind === 'task-notification') onTaskNote?.(m);
        else onForegroundResult();
      }
      if (m.type === 'system' && any.subtype?.startsWith?.('task_')) onTaskNote?.(m);
    }
    console.log(`[${tag}] <generator ended>`);
  })();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMMON = {
  tools: { type: 'preset', preset: 'claude_code' } as const,
  // Auto-allow every tool so the background-Bash experiment isn't gated.
  canUseTool: async (_n: string, input: any) => ({ behavior: 'allow' as const, updatedInput: input }),
};

// ───────────────────────────────────────────────────────────────────────────
// Exp 1+2: session persists across turns + FIFO/origin correlation.
// ───────────────────────────────────────────────────────────────────────────
async function exp12() {
  console.log('\n=== EXP 1+2: persist across turns + origin/FIFO ===');
  const input = createInput();
  let resolveResult: (() => void) | null = null;
  const nextResult = () => new Promise<void>((r) => { resolveResult = r; });
  const q = query({ prompt: input.stream, options: { ...COMMON } }) as Query;
  const done = consume(q, 'e12', () => { resolveResult?.(); resolveResult = null; });

  let wait = nextResult();
  console.log('>>> push A: remember 42');
  input.push('Remember the number 42. Reply with just "ok".');
  await wait;

  wait = nextResult();
  console.log('>>> push B: recall (tests same-session context)');
  input.push('What number did I ask you to remember? Reply with just the number.');
  await wait;

  input.close();
  await done;
  console.log('OBSERVE: both results origin=human? B knew "42" → session alive. session_id same across A/B?');
}

// ───────────────────────────────────────────────────────────────────────────
// Exp 3: push a new turn while a backgrounded task is still running.
// ───────────────────────────────────────────────────────────────────────────
async function exp3() {
  console.log('\n=== EXP 3: push B during A background task ===');
  const input = createInput();
  let resolveResult: (() => void) | null = null;
  const nextResult = () => new Promise<void>((r) => { resolveResult = r; });
  const q = query({ prompt: input.stream, options: { ...COMMON } }) as Query;
  const done = consume(q, 'e3', () => { resolveResult?.(); resolveResult = null; },
    (m) => console.log(`   ↑ TASK lane: ${(m as any).subtype ?? 'result(task-notification)'}`));

  let wait = nextResult();
  console.log('>>> push A: start a 15s background bash');
  input.push('Run this shell command IN THE BACKGROUND (run_in_background): `sleep 15 && echo BG_DONE`. Immediately reply "started" without waiting for it.');
  await wait; // A foreground result (task still running)
  console.log('--- A foreground result in; pushing B BEFORE task settles ---');

  wait = nextResult();
  console.log('>>> push B: 2+2 (origin should be human, must not be swallowed)');
  input.push('What is 2+2? Reply with just the number.');
  await wait;
  console.log('--- B result in; now waiting up to 25s for A task settle + auto-resume ---');

  await sleep(25_000);
  input.close();
  await done;
  console.log('OBSERVE: ordering of B(human) vs A task_* / auto-resume(task-notification). Distinguishable by origin? B answered?');
}

// ───────────────────────────────────────────────────────────────────────────
// Exp 4: interrupt() stops current turn, session survives.
// ───────────────────────────────────────────────────────────────────────────
async function exp4() {
  console.log('\n=== EXP 4: interrupt() then continue ===');
  const input = createInput();
  let resolveResult: (() => void) | null = null;
  const nextResult = () => new Promise<void>((r) => { resolveResult = r; });
  const q = query({ prompt: input.stream, options: { ...COMMON } }) as Query;
  const done = consume(q, 'e4', () => { resolveResult?.(); resolveResult = null; });

  let wait = nextResult();
  console.log('>>> push A: long count (will interrupt mid-way)');
  input.push('Count from 1 to 200, one number per line, slowly. Do not stop early.');
  await sleep(4000);
  console.log('>>> interrupt()');
  try { await q.interrupt(); console.log('   interrupt() resolved'); }
  catch (e: any) { console.log('   interrupt() threw:', e?.message); }
  await Promise.race([wait, sleep(8000)]); // result may or may not come

  wait = nextResult();
  console.log('>>> push B after interrupt (tests session still alive)');
  input.push('Say "still here". Reply with just that.');
  await Promise.race([wait, sleep(15000)]);

  input.close();
  await done;
  console.log('OBSERVE: A stopped mid-count? B got a reply on the SAME query → session survived interrupt?');
}

// ───────────────────────────────────────────────────────────────────────────
// Bonus: mid-session setModel / setPermissionMode / setMaxThinkingTokens probe.
// ───────────────────────────────────────────────────────────────────────────
async function expControls() {
  console.log('\n=== BONUS: mid-session control methods ===');
  const input = createInput();
  const q = query({ prompt: input.stream, options: { ...COMMON } }) as Query;
  const done = consume(q, 'ctl', () => {});
  input.push('hi'); // open the session
  await sleep(3000);
  for (const [name, fn] of [
    ['setModel', () => q.setModel?.('claude-sonnet-4-5')],
    ['setPermissionMode', () => (q as any).setPermissionMode?.('plan')],
    ['setMaxThinkingTokens', () => (q as any).setMaxThinkingTokens?.(2048)],
  ] as const) {
    try { await (fn as any)(); console.log(`   ${name}() OK`); }
    catch (e: any) { console.log(`   ${name}() threw: ${e?.message}`); }
  }
  input.close();
  await done;
  console.log('OBSERVE: which control methods exist + resolve without throwing in streaming mode?');
}

async function main() {
  console.log('--- streaming-input spike start (ONLY=' + (ONLY || 'all') + ') ---');
  if (ONLY === 0 || ONLY === 1 || ONLY === 2) await exp12();
  if (ONLY === 0 || ONLY === 3) await exp3();
  if (ONLY === 0 || ONLY === 4) await exp4();
  if (ONLY === 0 || ONLY === 5) await expControls();
  console.log('\n--- spike end ---');
  process.exit(0);
}

main().catch((err) => { console.error('spike error:', err); process.exit(1); });
