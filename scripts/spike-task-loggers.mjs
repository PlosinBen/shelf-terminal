/**
 * Exercises the empty-background-task-card diagnostic loggers against the REAL
 * built agent-server bundle (claude provider). Drives three scenarios in one
 * session and surfaces every `[claude]`/`[copilot]` stderr logger line so we can
 * eyeball whether they fire as documented in
 * .agent/features/empty-background-task-cards.md.
 *
 *   Turn FG : foreground bash `echo SYNC_HELLO` (+ a TodoWrite list)
 *             → expect `[claude] dropped foreground bash task_started` (no card)
 *   Turn BG : background bash `sleep 15 && echo BG_DONE`
 *             → expect `[claude] carding ... task_type:'local_bash' bgState:'true'`
 *               a real output_file, NO "settled with no output file"
 *   Turn SUB: a backgrounded subagent (Task tool)
 *             → expect `[claude] carding ... bgState:'n/a'` and, on read,
 *               the inline-output (case 2) path
 *
 * Run (after `node agent-server/build.mjs`): node scripts/spike-task-loggers.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');

// stdout = wire protocol (parse it); stderr = pipe so we can TAG logger lines.
const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'pipe'] });
const out = createInterface({ input: proc.stdout });
const err = createInterface({ input: proc.stderr });
const lines = [];
const waiters = [];
const loggerHits = [];

out.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type === 'task_event') console.log(`  ▸ task_event kind=${m.kind} task=${JSON.stringify(m.task ?? m.tasks)}`);
  else if (m.type === 'permission_request') send({ type: 'resolve_permission', toolUseId: m.toolUseId, allow: true });
  for (const w of waiters) w(m);
});
err.on('line', (line) => {
  if (/\[claude\]|\[copilot\]/.test(line)) { loggerHits.push(line); console.log(`  🪵 ${line}`); }
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms) => new Promise((res) => {
  const hit = lines.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => res(null), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
});
const idle = (turnId, ms) => waitFor((m) => m.type === 'status' && m.state === 'idle' && m.turnId === turnId, ms);
const anyTaskId = () => {
  for (const m of lines) if (m.type === 'task_event') {
    if (m.task?.id) return m.task.id;
    if (m.tasks?.[0]?.id) return m.tasks[0].id;
  }
  return null;
};

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);
  const base = { provider: 'claude', cwd: root, sessionId: 'tasklog1', permissionMode: 'bypassPermissions' };

  console.log('\n=== Turn FG: foreground bash + todo list ===');
  send({ type: 'send', turnId: 't-fg', ...base,
    prompt: 'Do BOTH in this turn: (1) use TodoWrite to create a 2-item todo list ["check env","echo hello"]; '
      + '(2) run a NORMAL foreground shell command `echo SYNC_HELLO` (run_in_background=false) and WAIT for it. Then reply "fg done".' });
  await idle('t-fg', 60000);

  console.log('\n=== Turn BG: background bash ===');
  send({ type: 'send', turnId: 't-bg', ...base,
    prompt: 'Run this shell command IN THE BACKGROUND (run_in_background=true): `sleep 15 && echo BG_DONE`. Immediately reply "started".' });
  await idle('t-bg', 60000);
  await waitFor((m) => m.type === 'task_event' && (m.task?.id || m.tasks?.length), 10000);
  const bgId = anyTaskId();
  const readOut = async (label) => {
    const rq = 'rq-' + label;
    send({ type: 'read_task_output', taskId: bgId, requestId: rq });
    const r = await waitFor((m) => m.type === 'task_output' && m.requestId === rq, 8000);
    console.log(`  → read_task_output (${label}): ${JSON.stringify(r?.error ?? (r?.content ?? '').slice(0, 80))}`);
  };
  if (bgId) {
    console.log(`  → reading bg task ${bgId} WHILE RUNNING (expect empty — notification not arrived yet)`);
    await readOut('running');
    console.log(`  → waiting for bg task ${bgId} to COMPLETE, then re-read (mirrors user clicking a finished card)`);
    await waitFor((m) => m.type === 'task_event' && m.kind === 'done'
      && (m.task?.id === bgId || m.tasks?.some?.((t) => t.id === bgId && t.done)), 30000);
    await new Promise((r) => setTimeout(r, 1500)); // let a trailing task_notification land
    await readOut('completed');
  }

  console.log('\n=== Turn SUB: backgrounded subagent (case 2 inline-output) ===');
  send({ type: 'send', turnId: 't-sub', ...base,
    prompt: 'Launch ONE background subagent (Task tool, run it in the background) whose entire job is to reply with the single word "PONG". Immediately reply "spawned".' });
  await idle('t-sub', 90000);
  await waitFor((m) => m.type === 'task_event' && (m.task?.type === 'subagent' || m.tasks?.some?.((t) => t.type === 'subagent')), 15000);

  await new Promise((r) => setTimeout(r, 2000));
  console.log('\n=== LOGGER SUMMARY ===');
  if (!loggerHits.length) console.log('  (no [claude]/[copilot] logger lines captured)');
  else for (const l of loggerHits) console.log('  ' + l);
  proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('spike error:', e); proc.kill(); process.exit(1); });
