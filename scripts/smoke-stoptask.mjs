/**
 * Verify stop-task end-to-end: start a background task, send stop_task, confirm
 * a 'stopped' task_notification flows back as a task_event. Drives the bundled
 * agent-server against real claude. ✅ Confirmed working.
 *
 * NOTE: `task_started` can land just AFTER the foreground turn's idle (the SDK
 * emits it around the run_in_background tool-result), so this WAITS for a
 * task_event after the turn rather than checking synchronously — checking too
 * early was a false "no task" earlier. The SDK reliably emits task_started for
 * run_in_background:true (confirmed raw in scripts/spike-bg-notify.ts).
 *
 * Run (after `node agent-server/build.mjs`): node scripts/smoke-stoptask.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const bundle = join(root, 'dist', 'agent-server', `${version}`, 'index.mjs');

const proc = spawn('node', [bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });
const lines = [];
const waiters = [];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type === 'task_event') console.log(`  task_event kind=${m.kind} ${JSON.stringify(m.task ?? m.tasks)}`);
  else if (m.type === 'message') console.log(`  message ${m.msgType}${m.label ? '(' + m.label + ')' : ''}: sub=${(m.subtitle ?? '').slice(0, 40)} body=${JSON.stringify(m.body ?? '').slice(0, 120)} err=${m.errorMessage ?? ''}`);
  else if (m.type !== 'stream') console.log(`  ${m.type}${m.state ? ':' + m.state : ''}`);
  if (m.type === 'permission_request') send({ type: 'resolve_permission', toolUseId: m.toolUseId, allow: true });
  for (const w of waiters) w(m);
});
const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms) => new Promise((res) => {
  const hit = lines.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => res(null), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
});
const anyTaskId = () => {
  for (const m of lines) {
    if (m.type === 'task_event') {
      if (m.task?.id) return m.task.id;
      if (m.tasks?.[0]?.id) return m.tasks[0].id;
    }
  }
  return null;
};

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);
  const base = { provider: 'claude', cwd: root, sessionId: 'stoptask1', permissionMode: 'bypassPermissions' };
  // Mirror smoke-streaming-input's proven sequence (two context turns) — the SDK
  // reliably uses its task_started/notification mechanism there.
  console.log('ready — warmup turns');
  send({ type: 'send', turnId: 't-a', prompt: 'Remember the number 42. Reply with just "ok".', ...base });
  await waitFor((m) => m.type === 'status' && m.state === 'idle' && m.turnId === 't-a', 30000);
  send({ type: 'send', turnId: 't-b', prompt: 'What number did I ask you to remember? Reply with just the number.', ...base });
  await waitFor((m) => m.type === 'status' && m.state === 'idle' && m.turnId === 't-b', 30000);
  console.log('— starting a long background task\n');
  send({ type: 'send', turnId: 't-bg', ...base,
    prompt: 'Run this shell command IN THE BACKGROUND (run_in_background): `sleep 15 && echo BG_DONE`. Immediately reply "started" without waiting for it.' });
  await waitFor((m) => m.type === 'status' && m.state === 'idle' && m.turnId === 't-bg', 60000);

  // task_started can land just AFTER the foreground idle (then routeTask emits an
  // individual task_event), so wait for a task_event rather than checking now.
  await waitFor((m) => m.type === 'task_event' && (m.task?.id || m.tasks?.length), 10000);
  const taskId = anyTaskId();
  console.log(`\n${taskId ? '✅ got a background task id: ' + taskId : '💥 no task id seen'}`);
  if (!taskId) { proc.kill(); process.exit(1); }

  console.log('— sending stop_task');
  send({ type: 'stop_task', taskId });
  const stopped = await waitFor((m) => m.type === 'task_event'
    && ((m.task?.id === taskId && (m.task.status === 'stopped' || m.task.done))
      || m.tasks?.some((t) => t.id === taskId && (t.status === 'stopped' || t.done))), 30000);
  console.log(stopped ? '\n✅ task settled after stop_task (status reflects stop)' : '\n💥 task did not settle after stop_task in 30s');
  proc.kill();
  process.exit(stopped ? 0 : 1);
}
main().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
