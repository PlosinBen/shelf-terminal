/**
 * Reproduces the REAL-APP empty-bg-bash-card scenario against the built bundle:
 * spawn a backgrounded bash in a turn that CLOSES before the bash finishes, then
 * sit IDLE (send no further turns) while it completes. The broad `[claude] sdkmsg`
 * logger then shows HOW (and whether) the completion/output_file is delivered
 * during idle, and which router lane it lands on. Contrast with
 * spike-task-loggers.mjs where later turns keep the stream active.
 *
 * Run (after `node agent-server/build.mjs`): node scripts/spike-bg-idle.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');

const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'pipe'] });
const out = createInterface({ input: proc.stdout });
const err = createInterface({ input: proc.stderr });
const lines = [];
const waiters = [];

out.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type === 'task_event') console.log(`  ▸ task_event kind=${m.kind} task=${JSON.stringify(m.task ?? m.tasks)}`);
  else if (m.type === 'permission_request') send({ type: 'resolve_permission', toolUseId: m.toolUseId, allow: true });
  for (const w of waiters) w(m);
});
err.on('line', (line) => { if (/\[claude\] (sdkmsg|carding|recorded|task_notification|router dropped|readTaskOutput|dropped foreground)/.test(line)) console.log(`  🪵 ${line}`); });

const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms) => new Promise((res) => {
  const hit = lines.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => res(null), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
});
const idle = (turnId, ms) => waitFor((m) => m.type === 'status' && m.state === 'idle' && m.turnId === turnId, ms);

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);
  const base = { provider: 'claude', cwd: root, sessionId: 'bgidle1', permissionMode: 'bypassPermissions' };

  console.log('\n=== Turn BG: spawn bg bash, turn CLOSES before it finishes ===');
  send({ type: 'send', turnId: 't-bg', ...base,
    prompt: 'Run this shell command IN THE BACKGROUND (run_in_background=true): `sleep 12 && echo BG_DONE`. Immediately reply "started" — do NOT wait.' });
  await idle('t-bg', 60000);
  console.log('  (turn t-bg is now CLOSED / session IDLE — bash still running)');

  console.log('\n=== IDLE WAIT 20s — watch what the SDK emits when the bash completes ===');
  await new Promise((r) => setTimeout(r, 20000));

  const bgId = (() => { for (const m of lines) if (m.type === 'task_event' && m.task?.id) return m.task.id; return null; })();
  console.log(`\n=== Now read_task_output for ${bgId} (mirrors clicking the finished card) ===`);
  if (bgId) {
    send({ type: 'read_task_output', taskId: bgId, requestId: 'rq1' });
    const r = await waitFor((m) => m.type === 'task_output' && m.requestId === 'rq1', 8000);
    console.log(`  → read_task_output: ${JSON.stringify(r?.error ?? (r?.content ?? '').slice(0, 80))}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
  proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('spike error:', e); proc.kill(); process.exit(1); });
