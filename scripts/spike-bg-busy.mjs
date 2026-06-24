/**
 * Companion to spike-bg-idle.mjs. Launches a backgrounded bash, then keeps the
 * session BUSY with back-to-back input turns while the task runs to completion.
 * The `[claude] rx` raw logger then shows whether the SDK still delivers the
 * terminal task_notification (with output_file) when the session never idles —
 * isolating "is task_notification idle-gated?" from agent-turn noise.
 *
 *   idle  variant (spike-bg-idle): expect rx task_notification output_file:set
 *   busy  variant (this):          does it still arrive, or not?
 *
 * Run (after `node agent-server/build.mjs`): node scripts/spike-bg-busy.mjs
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
let sawNotification = false;

out.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  lines.push(m);
  if (m.type === 'task_event') console.log(`  ▸ task_event kind=${m.kind} task=${JSON.stringify(m.task ?? m.tasks)}`);
  else if (m.type === 'permission_request') send({ type: 'resolve_permission', toolUseId: m.toolUseId, allow: true });
  for (const w of waiters) w(m);
});
err.on('line', (line) => {
  if (/\[claude\] (rx|carding|recorded|task_notification)/.test(line)) {
    if (/task_notification/.test(line)) sawNotification = true;
    console.log(`  🪵 ${line}`);
  }
});

const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
const waitFor = (pred, ms) => new Promise((res) => {
  const hit = lines.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => res(null), ms);
  waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
});
const idle = (turnId, ms) => waitFor((m) => m.type === 'status' && m.state === 'idle' && m.turnId === turnId, ms);

async function main() {
  await waitFor((m) => m.type === 'ready', 30000);
  const base = { provider: 'claude', cwd: root, sessionId: 'bgbusy1', permissionMode: 'bypassPermissions' };

  console.log('\n=== Turn BG: spawn bg bash (sleep 12), then keep the session BUSY ===');
  send({ type: 'send', turnId: 't-bg', ...base,
    prompt: 'Run this shell command IN THE BACKGROUND (run_in_background=true): `sleep 12 && echo BG_DONE`. Immediately reply "started".' });
  await idle('t-bg', 60000);

  // Keep BUSY: 8 quick turns ~2s apart spanning the bash's 12s lifetime, so the
  // session is never idle when the task settles.
  for (let i = 1; i <= 8; i++) {
    const id = `t-busy${i}`;
    send({ type: 'send', turnId: id, ...base, prompt: `Reply with just the number ${i}.` });
    await idle(id, 30000);
    console.log(`  (busy turn ${i} done${sawNotification ? ' — notification already seen' : ''})`);
  }

  // Tail: small idle window at the very end to see if a deferred notification
  // shows up only once busy-ness stops.
  console.log('\n=== Tail: 8s idle after the busy burst ===');
  await new Promise((r) => setTimeout(r, 8000));

  console.log('\n=== VERDICT ===');
  console.log(sawNotification
    ? '✅ task_notification ARRIVED even under continuous busy turns → NOT idle-gated.'
    : '❌ task_notification NEVER arrived during the busy burst → delivery is idle-gated (busy starves it).');
  proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('spike error:', e); proc.kill(); process.exit(1); });
